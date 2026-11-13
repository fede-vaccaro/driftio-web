// The dedicated parser worker (plans/web/wasm-web-build.md, phase 3.4): loads
// the minimal Emscripten module and runs one parse job at a time, so the main
// thread only ever sees transferred result buffers.

import createDriftioWorker from './driftio_worker.js';

const modulePromise = createDriftioWorker({
  locateFile: (path) => new URL(path, import.meta.url).href,
});

function allocString(mod, text) {
  const bytes = new TextEncoder().encode(text || '');
  const ptr = mod._malloc(bytes.length + 1);
  mod.HEAPU8.set(bytes, ptr);
  mod.HEAPU8[ptr + bytes.length] = 0;
  return { ptr, length: bytes.length };
}

function call(mod, name, ret, types, args) {
  return mod.ccall(name, ret, types, args);
}


let assetPort = null;
let nextReadId = 1;
const pendingReads = new Map();

function requestAsset(path) {
  if (!assetPort) return Promise.reject(new Error('parser worker has no asset port'));
  const readId = nextReadId++;
  return new Promise((resolve, reject) => {
    pendingReads.set(readId, { resolve, reject });
    assetPort.postMessage({ type: 'read', readId, path });
  });
}

function resolveSibling(from, reference) {
  const parts = from.split('/');
  parts.pop();
  for (const part of reference.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (parts.length) parts.pop(); } else parts.push(part);
  }
  return parts.join('/');
}

function mtllibOf(bytes) {
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 1 << 16)));
  for (const line of head.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('mtllib ')) return trimmed.slice(7).trim();
  }
  return null;
}

self.onmessage = async (event) => {
  const job = event.data;
  if (job && job.type === 'connectAsset') {
    assetPort = job.port;
    assetPort.onmessage = (message) => {
      const reply = message.data || {};
      const pending = pendingReads.get(reply.readId);
      if (!pending) return;
      pendingReads.delete(reply.readId);
      if (reply.ok) pending.resolve(reply.bytes);
      else pending.reject(new Error(reply.error || 'asset read failed'));
    };
    return;
  }
  if (job && job.type === 'bundle') {
    try {
      const model = job.dmfPath ? await requestAsset(job.dmfPath) : new Uint8Array(0);
      const collision = job.collisionPath ? await requestAsset(job.collisionPath) : new Uint8Array(0);
      const transfer = [];
      if (model.length) transfer.push(model.buffer);
      if (collision.length) transfer.push(collision.buffer);
      self.postMessage({ id: job.id, ok: true, model, collision, textures: job.textures || '' }, transfer);
    } catch (error) {
      self.postMessage({ id: job.id, ok: false, error: error && error.message ? error.message : String(error) });
    }
    return;
  }
  if (job && job.type === 'objAsset') {
    try {
      job.obj = await requestAsset(job.objPath);
      const mtlName = job.mtlPath || mtllibOf(job.obj);
      job.mtl = mtlName ? await requestAsset(resolveSibling(job.objPath, mtlName)) : new Uint8Array(0);
    } catch (error) {
      self.postMessage({ id: job.id, ok: false, error: error && error.message ? error.message : String(error) });
      return;
    }
  }
  if (job && job.type === 'forget') {
    const mod = await modulePromise;
    const key = allocString(mod, job.key || '');
    call(mod, 'driftio_worker_forget', 'number', ['number'], [key.ptr]);
    mod._free(key.ptr);
    return;
  }
  const { id } = job;
  try {
    const mod = await modulePromise;
    const obj = job.obj;
    const mtl = job.mtl || new Uint8Array(0);
    const base = allocString(mod, job.baseDir || '');
    const cacheKey = allocString(mod, job.cacheKey || '');
    const objPtr = mod._malloc(Math.max(1, obj.length));
    const mtlPtr = mod._malloc(Math.max(1, mtl.length));
    const matrices = job.matrices || null;
    const matrixCount = matrices ? Math.floor(matrices.length / 16) : 0;
    const matrixPtr = mod._malloc(Math.max(16, matrixCount * 16) * 4);
    try {
      mod.HEAPU8.set(obj, objPtr);
      mod.HEAPU8.set(mtl, mtlPtr);
      if (matrices && matrixCount) {
        const f32 = new Float32Array(mod.HEAPU8.buffer, matrixPtr, matrixCount * 16);
        f32.set(matrices);
      } else {
        const f32 = new Float32Array(mod.HEAPU8.buffer, matrixPtr, 16);
        f32.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      }

      const ok = call(mod, 'driftio_worker_parse', 'number',
        ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number'],
        [objPtr, obj.length, mtlPtr, mtl.length, base.ptr, matrixPtr, matrixCount, job.needCollision ? 1 : 0,
         cacheKey.ptr, job.needModel === false ? 0 : 1]);

      if (!ok) {
        const error = call(mod, 'driftio_worker_error', 'string', [], []);
        self.postMessage({ id, ok: false, error: error || 'parse failed' });
        return;
      }

      const modelSize = call(mod, 'driftio_worker_model_size', 'number', [], []);
      const modelPtr = call(mod, 'driftio_worker_model_data', 'number', [], []);
      const collisionSize = call(mod, 'driftio_worker_collision_size', 'number', [], []);
      const collisionPtr = call(mod, 'driftio_worker_collision_data', 'number', [], []);
      const textures = call(mod, 'driftio_worker_texture_paths', 'string', [], []) || '';
      const model = new Uint8Array(mod.HEAPU8.buffer, modelPtr, modelSize).slice();
      const collision = new Uint8Array(mod.HEAPU8.buffer, collisionPtr, collisionSize).slice();

      const transfer = [model.buffer];
      if (collision.length) transfer.push(collision.buffer);
      self.postMessage({ id, ok: true, model, collision, textures }, transfer);
    } finally {
      mod._free(objPtr);
      mod._free(mtlPtr);
      mod._free(matrixPtr);
      mod._free(base.ptr);
      mod._free(cacheKey.ptr);
    }
  } catch (error) {
    self.postMessage({ id, ok: false, error: error && error.message ? error.message : String(error) });
  }
};
