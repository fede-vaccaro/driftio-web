// The page's own logic (plans/web/wasm-web-build.md): pick the assets ZIP,
// stage the startup files, run the engine, then stream the island's cells in
// through the parser worker until the spawn cell is ready.

import createDriftio from './index.js';
import { AssetClient } from './asset-client.js';
import { WorkerPool } from './worker-host.js';

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const overlay = $('overlay');
const statusText = $('status');
const errorText = $('error');
const bar = $('fill');
const input = $('archive');
const gameUi = $('game-ui');
const timeOfDay = $('time-of-day');
const carSelect = $('car');
const volume = $('volume');
const volumeValue = $('volume-value');
const uiStatus = $('ui-status');
const debugLog = new URLSearchParams(location.search).has('debug');

const state = {
  ready: false, archive: null, archiveName: '', archiveSize: 0, module: null, pool: null, bundle: null,
  textureIssues: [], textureIssueSet: new Set(),
};
const decodingTextures = new Map();
const textureProblems = [];

function noteTextureProblem(path, reason) {
  textureProblems.push({ path, reason });
  if (textureProblems.length > 100) textureProblems.shift();
  console.warn(`driftio: texture problem ${path}: ${reason}`);
}
let textureDecoder = null;

class TextureDecoder {
  constructor(asset, count = 2) {
    this.workers = [];
    this.pending = new Map();
    this.nextId = 1;
    this.nextWorker = 0;
    for (let i = 0; i < count; ++i) {
      const worker = new Worker(new URL('./texture-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (event) => {
        const job = this.pending.get(event.data.id);
        if (!job) return;
        this.pending.delete(event.data.id);
        if (event.data.ok) job.resolve(event.data);
        else job.reject(new Error(event.data.error || 'texture decode failed'));
      };
      worker.onerror = (event) => {
        for (const job of this.pending.values()) job.reject(new Error(event.message || 'texture worker failed'));
        this.pending.clear();
      };
      asset.connect(worker, 'texture');
      this.workers.push(worker);
    }
  }

  decode(path) {
    const worker = this.workers[this.nextWorker++ % this.workers.length];
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, path });
    });
  }
}

function textureWorkers() {
  if (!textureDecoder) textureDecoder = new TextureDecoder(state.archive, 4);
  return textureDecoder;
}

// A missing optional layer map is harmless, but a missing diffuse/normal is a
// visible hole. Keep both in one list so ?debug=1 (or the console) names the
// exact archive path instead of leaving a black material to guess at.
function reportTextureIssue(path, reason) {
  const line = `${reason}: ${path}`;
  if (state.textureIssueSet.has(line)) return;
  state.textureIssueSet.add(line);
  if (state.textureIssues.length < 200) state.textureIssues.push(line);
  if (reason !== 'optional texture not in archive' || debugLog) console.warn('driftio: texture', line);
}

// True while C++ still owns this texture or its staged bytes. This is the
// important difference from a permanent "decoded once" set: after a cell
// unloads, its texture is gone and the page must decode and stage it again.
function textureAvailable(path) {
  if (!state.module) return false;
  try {
    return ccall('driftio_web_texture_available', 'number', ['string'], [path]) !== 0;
  } catch {
    return false;
  }
}

function stageEncodedTexture(path, bytes) {
  const M = state.module;
  const ptr = M._malloc(Math.max(1, bytes.byteLength));
  try {
    if (bytes.byteLength) M.HEAPU8.set(bytes, ptr);
    ccall('driftio_web_put_texture', 'number', ['string', 'number', 'number'],
      [path, ptr, bytes.byteLength]);
  } finally {
    M._free(ptr);
  }
}

async function decodeTexture(path) {
  if (textureAvailable(path)) return;
  if (decodingTextures.has(path)) return decodingTextures.get(path);
  const promise = (async () => {
    const started = performance.now();
    const archivePath = zipName(path);
    if (!state.archive.has(archivePath)) {
      reportTextureIssue(path, 'optional texture not in archive');
      return;
    }
    const image = await textureWorkers().decode(path);
    if (!image || !image.width || !image.height || !image.rgba || !image.rgba.byteLength) {
      throw new Error('worker returned an empty image');
    }

    // Keep the encoded file as the reload fallback. Decoded pixels save the
    // stb decode on the first upload; the encoded bytes cover a consumed image
    // (or an image the worker could not decode) without a missing white one.
    if (image.bytes && image.bytes.byteLength) {
      try {
        stageEncodedTexture(path, new Uint8Array(image.bytes));
      } catch (error) {
        reportTextureIssue(path, `encoded texture staging failed: ${error && error.message ? error.message : error}`);
      }
    }

    // An all-zero RGBA image is valid (some shop signs are intentionally
    // transparent), so do not reject it here. The worker throws only on a
    // real decode failure.
    await queueDecodedTexture(path, image);
    if (debugLog) console.log(`driftio: texture ${path} ${Math.round(performance.now() - started)} ms (${image.width}x${image.height})`);
  })();
  decodingTextures.set(path, promise);
  try {
    await promise;
  } finally {
    decodingTextures.delete(path);
  }
}

// The worker's RGBA still has to enter the wasm heap. A 3380-square ground mask
// is ~45 MB, and copying several of those back-to-back in one cell is one of
// the frame-time spikes. Queue the transfer and copy a bounded slice per
// animation frame; the cell waits for it, the camera does not.
const decodedQueue = [];
let decodedPumpScheduled = false;

function queueDecodedTexture(path, image) {
  return new Promise((resolve, reject) => {
    decodedQueue.push({ path, image, offset: 0, ptr: 0, resolve, reject });
    scheduleDecodedPump();
  });
}

function scheduleDecodedPump() {
  if (decodedPumpScheduled) return;
  decodedPumpScheduled = true;
  requestAnimationFrame(pumpDecodedTextures);
}

function pumpDecodedTextures() {
  decodedPumpScheduled = false;
  const start = performance.now();
  const budgetMs = state.ready ? 6 : 16;
  const copyBytesPerFrame = 8 * 1024 * 1024;
  const M = state.module;
  while (decodedQueue.length) {
    const job = decodedQueue[0];
    const rgba = new Uint8Array(job.image.rgba);
    if (!job.ptr) job.ptr = M._malloc(Math.max(1, rgba.byteLength));
    const remaining = rgba.byteLength - job.offset;
    const n = Math.min(remaining, copyBytesPerFrame);
    if (n > 0) {
      M.HEAPU8.set(rgba.subarray(job.offset, job.offset + n), job.ptr + job.offset);
      job.offset += n;
    }
    if (job.offset < rgba.byteLength) break;
    decodedQueue.shift();
    try {
      ccall('driftio_web_put_decoded_texture', 'number', ['string', 'number', 'number', 'number'],
        [job.path, job.ptr, job.image.width, job.image.height]);
      job.resolve();
    } catch (error) {
      M._free(job.ptr);
      reportTextureIssue(job.path, `decoded handoff failed: ${error && error.message ? error.message : error}`);
      job.reject(error);
    }
    if (performance.now() - start >= budgetMs) break;
  }
  if (decodedQueue.length) scheduleDecodedPump();
}

async function prepareTexture(path) {
  try {
    await decodeTexture(path);
  } catch (error) {
    reportTextureIssue(path, `texture worker decode failed: ${error && error.message ? error.message : error}`);
    console.warn('driftio: texture worker decode failed:', path, error);
  }
}

function stageTextures(paths) {
  return Promise.all((paths || []).map((path) => prepareTexture(path)));
}

let modulePromise = null;
function loadModule() {
  if (!modulePromise) {
    modulePromise = createDriftio({
      canvas,
      print: (...args) => console.log(...args),
      printErr: (...args) => console.error(...args),
      locateFile: (path) => path,
      noExitRuntime: true,
    });
  }
  return modulePromise;
}

function setStatus(text) { statusText.textContent = text; }
function setError(text) {
  errorText.textContent = text;
  if (text) console.error('driftio:', text);
}
function setProgress(fraction) {
  bar.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
}
function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isStartupFile(path) {
  if (path.startsWith('assets/vehicles/') || path.startsWith('assets/audio/')) return true;
  if (path === 'assets/textures/index.json') return true;
  if (path.startsWith('assets/maps/island/') && (path.endsWith('.json') || path.endsWith('.bin'))) return true;
  return false;
}

// --- Cell streaming (phases 3.6, 4 and 5.7) --------------------------------

function ccall(name, ret, types, args) {
  return state.module.ccall(name, ret, types, args);
}

function normalizeArchivePath(path) {
  return path.replace(/^\/+/, '');
}

function zipName(archivePath) {
  return archivePath.replace(/^\/+/, '');
}

function installBytes(path, modelBytes, collisionBytes, chunkKey) {
  const M = state.module;
  const model = modelBytes || new Uint8Array(0);
  const collision = collisionBytes || new Uint8Array(0);
  const modelPtr = M._malloc(Math.max(1, model.length));
  const collPtr = M._malloc(Math.max(1, collision.length));
  const started = performance.now();
  try {
    if (model.length) M.HEAPU8.set(model, modelPtr);
    if (collision.length) M.HEAPU8.set(collision, collPtr);
    const ok = ccall('driftio_web_install_model', 'number',
      ['string', 'number', 'number', 'number', 'number', 'string'],
      [path, modelPtr, model.length, collPtr, collision.length, chunkKey]);
    if (!ok) {
      const error = ccall('driftio_web_last_error', 'string', [], []);
      throw new Error(error || `cannot install ${path}`);
    }
  } finally {
    M._free(modelPtr);
    M._free(collPtr);
  }
  return performance.now() - started;
}

function workerPool() {
  if (!state.pool) state.pool = new WorkerPool(state.archive, 2);
  return state.pool;
}

// A prebuilt web bundle (export_island --web-bundle) carries the .dmf model and
// the .coll collision for every streamed cell: no OBJ parse and no BVH build in
// the browser. Without a bundle, the worker parses the OBJ as before.
function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

// Uploads a model's submeshes over as many frames as the budget needs. Shape
// creation happens in begin; each step is one or more Mesh uploads; finish
// adopts the collision and makes the model visible. During the spawn overlay
// the whole model is uploaded at once; afterwards an ~8 ms slice keeps the
// frame alive while the prefetched cell finishes.
async function stagedInstall(path, wire, collision, chunkKey, cancelled) {
  const M = state.module;
  let beginMs = 0, stepMs = 0, finishMs = 0;
  const wirePtr = M._malloc(Math.max(1, wire.length));
  try {
    if (wire.length) M.HEAPU8.set(wire, wirePtr);
    const t = performance.now();
    const ok = ccall('driftio_web_install_model_begin', 'number', ['string', 'number', 'number'],
      [path, wirePtr, wire.length]);
    beginMs = performance.now() - t;
    if (!ok) throw new Error(ccall('driftio_web_last_error', 'string', [], []) || `cannot begin ${path}`);
  } finally {
    M._free(wirePtr);
  }

  let steps = 0;
  const stepStart = performance.now();
  for (;;) {
    if (cancelled && cancelled()) {
      ccall('driftio_web_install_model_cancel', 'number', [], []);
      throw new Error('cell cancelled');
    }
    const budget = state.ready ? 8 : 1000;
    const more = ccall('driftio_web_install_model_step', 'number', ['number'], [budget]);
    ++steps;
    if (!more) break;
    if (state.ready) await nextFrame();
  }
  stepMs = performance.now() - stepStart;

  const collPtr = M._malloc(Math.max(1, collision.length));
  try {
    if (collision.length) M.HEAPU8.set(collision, collPtr);
    const t = performance.now();
    const ok = ccall('driftio_web_install_model_finish', 'number',
      ['string', 'number', 'number', 'string'], [path, collPtr, collision.length, chunkKey]);
    finishMs = performance.now() - t;
    if (!ok) throw new Error(ccall('driftio_web_last_error', 'string', [], []) || `cannot finish ${path}`);
  } finally {
    M._free(collPtr);
  }
  return { steps, beginMs, stepMs, finishMs, totalMs: beginMs + stepMs + finishMs };
}

let installChain = Promise.resolve();

function withInstallLock(task) {
  const run = installChain.then(task, task);
  installChain = run.catch(() => {});
  return run;
}

async function prepareModel(path, matrices, chunkKey, cancelled) {
  const timing = {
    path, wireBytes: 0, collisionBytes: 0,
    fetchWire: 0, fetchCollision: 0, stage: 0, parse: 0, install: 0, steps: 0,
  };
  const alreadyLoaded = ccall('driftio_web_has_model', 'number', ['string'], [path]) !== 0;
  const info = state.bundle && state.bundle.models ? state.bundle.models[path] : null;
  const wirePath = info && info.dmf ? info.dmf : path.replace(/\.obj$/i, '.dmf');
  if (info && state.archive.has(zipName(wirePath))) {
    const entry = state.bundle.cells ? state.bundle.cells[chunkKey] : null;
    if (entry && entry.collision && !state.archive.has(zipName(entry.collision)))
      throw new Error(`missing collision in the ZIP: ${entry.collision}`);

    let stagePromise = Promise.resolve();
    if (!alreadyLoaded) {
      const t = performance.now();
      stagePromise = stageTextures(info.textures).then(() => {
        timing.stage = performance.now() - t;
      });
    }
    const t = performance.now();
    const bundlePromise = workerPool().bundle({
      dmfPath: alreadyLoaded ? '' : wirePath,
      collisionPath: entry && entry.collision ? entry.collision : '',
      textures: (info.textures || []).join('\n'),
      cacheKey: path,
    }).then((result) => {
      timing.wireBytes = result.model ? result.model.length : 0;
      timing.collisionBytes = result.collision ? result.collision.length : 0;
      timing.fetchWire = performance.now() - t;
      timing.fetchCollision = performance.now() - t;
      return result;
    });
    const [{ model: wire, collision }] = await Promise.all([bundlePromise, stagePromise]);
    return { path, matrices, chunkKey, alreadyLoaded, wire, collision, timing };
  }

  const archivePath = zipName(path);
  if (!state.archive.has(archivePath)) throw new Error(`missing model in the ZIP: ${archivePath}`);

  const registryPath = normalizeArchivePath(path);
  const baseDir = '/' + registryPath.slice(0, registryPath.lastIndexOf('/'));
  let t = performance.now();
  const result = await workerPool().parseAsset({
    objPath: archivePath,
    baseDir,
    matrices,
    needCollision: true,
    cacheKey: path,
    needModel: !alreadyLoaded,
  });
  timing.wireBytes = result.model ? result.model.length : 0;
  timing.collisionBytes = result.collision ? result.collision.length : 0;
  timing.fetchWire = performance.now() - t;
  timing.parse = performance.now() - t;

  if (!alreadyLoaded && result.textures) {
    t = performance.now();
    await stageTextures(result.textures.split('\n').filter(Boolean));
    timing.stage = performance.now() - t;
  }

  return { path, matrices, chunkKey, alreadyLoaded, wire: result.model, collision: result.collision, timing };
}

async function installPrepared(prepared, cancelled) {
  if (cancelled && cancelled()) throw new Error('cell cancelled');
  const { path, chunkKey, alreadyLoaded, collision, timing } = prepared;
  const wire = alreadyLoaded || ccall('driftio_web_has_model', 'number', ['string'], [path]) !== 0
    ? null
    : prepared.wire;
  const started = performance.now();
  if (wire && wire.length) {
    const staged = await withInstallLock(async () => {
      if (cancelled && cancelled()) throw new Error('cell cancelled');
      return stagedInstall(path, wire, collision, chunkKey, cancelled);
    });
    timing.steps = staged.steps;
    timing.staged = staged;
  } else {
    await withInstallLock(async () => {
      if (cancelled && cancelled()) throw new Error('cell cancelled');
      installBytes(path, null, collision, chunkKey);
    });
  }
  timing.install = performance.now() - started;
  return timing;
}

async function installModel(path, matrices, chunkKey, cancelled) {
  const prepared = await prepareModel(path, matrices, chunkKey, cancelled);
  return installPrepared(prepared, cancelled);
}

// One entry per requested cell: queued behind a priority scheduler, or being
// prepared/installed by one of two concurrent cell runners. Preparation runs
// in parallel; the main-thread install itself stays serialized by installChain.
const MAX_ACTIVE_CELLS = 2;
const cellJobs = new Map();
let activeCells = 0;
let pumpScheduled = false;
let lastCellMs = 0;
let maxCellMs = 0;

function cellKey(cx, cz) {
  return `${cx}_${cz}`;
}

function cellWanted(cx, cz) {
  return ccall('driftio_web_cell_wanted', 'number', ['number', 'number'], [cx, cz]) !== 0;
}

function cellPriority(cx, cz) {
  return ccall('driftio_web_cell_priority', 'number', ['number', 'number'], [cx, cz]);
}

function cancelCell(cx, cz) {
  ccall('driftio_web_cell_cancelled', 'number', ['number', 'number'], [cx, cz]);
}

function schedulePump() {
  if (pumpScheduled) return;
  pumpScheduled = true;
  Promise.resolve().then(pump);
}

function pump() {
  pumpScheduled = false;
  for (const [key, job] of [...cellJobs]) {
    if (job.state === 'queued' && !cellWanted(job.cx, job.cz)) {
      cancelCell(job.cx, job.cz);
      cellJobs.delete(key);
    }
  }
  while (activeCells < MAX_ACTIVE_CELLS) {
    let next = null;
    let best = Infinity;
    for (const job of cellJobs.values()) {
      if (job.state !== 'queued') continue;
      const priority = cellPriority(job.cx, job.cz);
      if (priority < best) {
        best = priority;
        next = job;
      }
    }
    if (!next) break;
    next.state = 'active';
    ccall('driftio_web_cell_started', 'number', ['number', 'number'], [next.cx, next.cz]);
    activeCells += 1;
    runCell(next).finally(() => {
      activeCells -= 1;
      schedulePump();
    });
  }
}

async function runCell(job) {
  const { cx, cz } = job;
  const key = cellKey(cx, cz);
  const M = state.module;
  const started = performance.now();
  const activeStart = started;
  const timing = {
    key, models: 0, wireBytes: 0, collisionBytes: 0,
    queue: activeStart - (job.queuedAt || activeStart),
    fetchWire: 0, fetchCollision: 0, stage: 0, parse: 0, install: 0, steps: 0, total: 0,
  };
  try {
    const count = ccall('driftio_web_cell_model_count', 'number', ['number', 'number'], [cx, cz]);
    job.modelCount = count;
    for (let i = 0; i < count; ++i) {
      if (!cellWanted(cx, cz)) {
        cancelCell(cx, cz);
        return;
      }
      const path = ccall('driftio_web_cell_model_path', 'string', ['number', 'number', 'number'], [cx, cz, i]);
      const matrixCount = ccall('driftio_web_cell_model_matrix_count', 'number',
        ['number', 'number', 'number'], [cx, cz, i]);
      const matrixPtr = ccall('driftio_web_cell_model_matrices', 'number',
        ['number', 'number', 'number'], [cx, cz, i]);
      const matrices = matrixPtr
        ? new Float32Array(M.HEAPU8.buffer, matrixPtr, matrixCount * 16).slice()
        : new Float32Array(0);
      const modelTiming = await installModel(path, matrices, `${key}|${path}`,
        () => !cellWanted(cx, cz));
      timing.models += 1;
      timing.wireBytes += modelTiming.wireBytes;
      timing.collisionBytes += modelTiming.collisionBytes;
      timing.fetchWire += modelTiming.fetchWire;
      timing.fetchCollision += modelTiming.fetchCollision;
      timing.stage += modelTiming.stage;
      timing.parse += modelTiming.parse;
      timing.install += modelTiming.install;
      timing.steps += modelTiming.steps || 0;
      if (debugLog && modelTiming.install > 80) {
        const staged = modelTiming.staged;
        console.log(`driftio: slow install ${path} ${Math.round(modelTiming.install)} ms` +
          (staged
            ? ` (begin ${Math.round(staged.beginMs)}, steps ${staged.steps} / ${Math.round(staged.stepMs)},` +
              ` finish ${Math.round(staged.finishMs)})`
            : ''));
      }
      job.done = i + 1;
      setStatus(`Streaming cell ${key}: ${job.done} / ${count} models`);
    }
    if (!cellWanted(cx, cz)) {
      cancelCell(cx, cz);
      return;
    }
    ccall('driftio_web_cell_loaded', 'number', ['number', 'number'], [cx, cz]);
    const ms = performance.now() - started;
    lastCellMs = ms;
    maxCellMs = Math.max(maxCellMs, ms);
    timing.total = performance.now() - (job.queuedAt || activeStart);
    state.lastCell = timing;
    const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(1);
    if (debugLog) {
      console.log(`driftio: cell ${key} ${timing.models} models, wire ${mb(timing.wireBytes)} MB,` +
        ` coll ${mb(timing.collisionBytes)} MB, queue ${Math.round(timing.queue)} ms,` +
        ` fetch wire ${Math.round(timing.fetchWire)} / coll ${Math.round(timing.fetchCollision)} ms,` +
        ` stage ${Math.round(timing.stage)} ms, parse ${Math.round(timing.parse)} ms,` +
        ` install ${Math.round(timing.install)} ms (${timing.steps} steps), total ${Math.round(timing.total)} ms`);
    }
  } catch (error) {
    if (!cellWanted(cx, cz)) {
      cancelCell(cx, cz);
      return;
    }
    const message = error && error.message ? error.message : String(error);
    ccall('driftio_web_cell_failed', 'number', ['number', 'number', 'string'], [cx, cz, message]);
    console.error('driftio: cell', cx, cz, message);
  } finally {
    cellJobs.delete(key);
  }
}

function loadCell(cx, cz) {
  const key = cellKey(cx, cz);
  if (cellJobs.has(key)) return;
  cellJobs.set(key, { cx, cz, state: 'queued', queuedAt: performance.now() });
  schedulePump();
}

function queuedCells() {
  let n = 0;
  for (const job of cellJobs.values()) if (job.state === 'queued') n += 1;
  return n;
}

function streamStats() {
  const s = (which) => ccall('driftio_web_stream_stats', 'number', ['number'], [which]);
  return {
    models: s(0),
    chunks: s(1),
    cells: s(2),
    loading: s(3),
    radius: s(4),
    spawnReady: s(5),
    desired: s(6),
    lastCellMs: s(7) || lastCellMs,
    maxCellMs: s(8) || maxCellMs,
    lastInstallMs: s(9),
    maxInstallMs: s(10),
    maxWireMs: s(15),
    maxGpuMs: s(16),
    maxCollisionMs: s(17),
    maxChunkMs: s(18),
    lastCell: state.lastCell || null,
    queued: queuedCells(),
    active: activeCells,
    pendingParses: state.pool ? state.pool.pendingCount : 0,
  };
}

const streamingEl = $('streaming');
function updateStreaming() {
  if (!state.ready) return;
  const stats = streamStats();
  const busy = stats.loading;  // requested and not yet finished (queued + active)
  if (busy > 0) {
    const parts = [`${busy} cell${busy === 1 ? '' : 's'}`];
    if (stats.pendingParses) parts.push(`${stats.pendingParses} parses`);
    if (stats.lastCellMs) parts.push(`last ${Math.round(stats.lastCellMs)} ms`);
    streamingEl.textContent = `streaming · ${parts.join(' · ')}`;
    streamingEl.classList.remove('hidden');
  } else {
    streamingEl.classList.add('hidden');
  }
}

// Keeps the overlay up until the whole drawn spawn ring (with its collision)
// is in: the far plane shows the edge of a smaller ring, and a baked tile is
// centred on a grid point so the ground under the spawn can come from a
// neighbouring cell.
function waitForSpawn(timeoutMs = 600000) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (ccall('driftio_web_spawn_ready', 'number', [], [])) { resolve(performance.now() - started); return; }
      const error = ccall('driftio_web_last_error', 'string', [], []);
      const stats = streamStats();
      if (error && stats.loading === 0 && stats.cells === 0) { reject(new Error(error)); return; }
      setStatus(`Loading the island · ${stats.cells} cells, ${stats.models} models` +
        (stats.loading ? ` (${stats.loading} loading, ${stats.queued} queued, ${stats.active} active)` : ''));
      if (performance.now() - started > timeoutMs) { reject(new Error('timed out loading spawn ring')); return; }
      setTimeout(tick, 250);
    };
    tick();
  });
}

// --- Archive picking -------------------------------------------------------

async function pickArchive(file) {
  if (!file) return;
  const pickedAt = performance.now();
  setError('');
  try {
    setStatus('Reading the archive directory...');
    const archive = new AssetClient();
    const opened = await archive.open(file);
    const names = archive.list();
    if (!archive.has('assets/maps/island/site.json') && !archive.has('assets/textures/index.json')) {
      throw new Error('this ZIP is not a driftio assets archive (no assets/maps/island/site.json)');
    }
    state.archive = archive;
    state.archiveName = file.name;
    state.archiveSize = opened.archiveSize || file.size;

    if (archive.has('assets/maps/island/web/stream.json')) {
      try {
        const bundle = JSON.parse(await archive.text('assets/maps/island/web/stream.json'));
        if (bundle.version !== 1) throw new Error(`unsupported stream.json version ${bundle.version}`);
        state.bundle = bundle;
        console.log(`driftio: web bundle ${Object.keys(bundle.models || {}).length} models, ` +
          `${Object.keys(bundle.cells || {}).length} cell entries`);
      } catch (error) {
        state.bundle = null;
        console.warn('driftio: web bundle ignored:', error);
      }
    }

    const startup = names.filter((path) => isStartupFile(path)).map((path) => ({ path }));
    const total = startup.reduce((sum, e) => sum + archive.size(e.path), 0);
    console.log(`driftio: archive ${file.name} (${human(file.size)}, ${names.length} entries)`);

    setStatus(`Preparing the engine... 0 / ${startup.length} files`);
    const Module = await loadModule();
    state.module = Module;

    let staged = 0;
    let done = 0;
    for (const entry of startup) {
      const bytes = await archive.bytes(entry.path);
      if (!Module.ccall('driftio_web_stage_asset_begin', 'number', ['string'], [entry.path]))
        throw new Error(`cannot stage ${entry.path} in the browser filesystem`);
      const chunkSize = 4 * 1024 * 1024;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
        const ptr = Module._malloc(Math.max(1, chunk.length));
        try {
          if (chunk.length) Module.HEAPU8.set(chunk, ptr);
          const ok = Module.ccall('driftio_web_stage_asset_append', 'number', ['number', 'number'],
            [ptr, chunk.length]);
          if (!ok) throw new Error(`cannot append ${entry.path}`);
        } finally {
          Module._free(ptr);
        }
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      if (!Module.ccall('driftio_web_stage_asset_end', 'number', [], []))
        throw new Error(`cannot finish staging ${entry.path}`);
      done += bytes.length;
      staged += 1;
      setProgress(total ? done / total : staged / startup.length);
      setStatus(`Staging ${staged} / ${startup.length} files · ${human(done)} / ${human(total)}`);
    }

    setStatus('Starting...');
    const startedAt = performance.now();
    Module.callMain([]);
    await waitForSpawn();
    state.ready = true;
    overlay.classList.add('hidden');
    gameUi.classList.remove('hidden');
    syncVolume();
    setInterval(updateStreaming, 500);
    canvas.focus();
    const stats = streamStats();
    const heapMb = (Module.HEAPU8.length / (1024 * 1024)).toFixed(0);
    console.log(`driftio: web spawn ready in ${((performance.now() - pickedAt) / 1000).toFixed(1)} s` +
      ` (${((performance.now() - startedAt) / 1000).toFixed(1)} s after start; ` +
      `${stats.cells} cells, ${stats.models} models, ${stats.chunks} chunks, ${heapMb} MB heap; ` +
      `last cell ${Math.round(stats.lastCellMs)} ms, max ${Math.round(stats.maxCellMs)} ms, ` +
      `max install ${Math.round(stats.maxInstallMs)} ms)`);
  } catch (error) {
    setError(error && error.message ? error.message : String(error));
    setStatus('Could not load the archive.');
  }
}

input.addEventListener('change', () => pickArchive(input.files && input.files[0]));

// --- In-game settings ------------------------------------------------------

let uiStatusTimer = 0;
function flashUi(text) {
  uiStatus.textContent = text;
  clearTimeout(uiStatusTimer);
  uiStatusTimer = setTimeout(() => { uiStatus.textContent = ''; }, 2500);
}

function setTimeOfDay(name) {
  if (!state.ready) return false;
  ccall('driftio_web_set_sky', 'number', ['string'], [name]);
  flashUi(`Lighting: ${name.replace(/_/g, ' ')}`);
  canvas.focus();
  return true;
}

function setCar(name) {
  if (!state.ready) return false;
  const ok = ccall('driftio_web_set_car', 'number', ['string'], [name]) !== 0;
  flashUi(ok ? `Car: ${name === 'hero_rx7' ? 'RX-7' : 'MX-5'}` : 'Could not switch car');
  canvas.focus();
  return ok;
}

function setExposure(value) {
  if (!state.ready) return false;
  ccall('driftio_web_set_exposure', 'number', ['number'], [value]);
  return true;
}

function setVolume(percent) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  volume.value = String(p);
  volumeValue.textContent = `${Math.round(p)}%`;
  if (!state.ready) return false;
  ccall('driftio_web_set_master_volume', 'number', ['number'], [p / 100]);
  flashUi(p > 0 ? `Volume: ${Math.round(p)}%` : 'Muted');
  return true;
}

function currentVolume() {
  if (!state.ready) return 0;
  return ccall('driftio_web_master_volume', 'number', [], []);
}

function syncVolume() {
  if (!state.ready) return;
  const p = Math.round(Math.max(0, Math.min(1, currentVolume())) * 100);
  volume.value = String(p);
  volumeValue.textContent = `${p}%`;
}

let activeTimeOfDay = timeOfDay.value;
let activeCar = carSelect.value;
timeOfDay.addEventListener('change', () => {
  if (setTimeOfDay(timeOfDay.value)) activeTimeOfDay = timeOfDay.value;
  else timeOfDay.value = activeTimeOfDay;
});
carSelect.addEventListener('change', () => {
  if (setCar(carSelect.value)) activeCar = carSelect.value;
  else carSelect.value = activeCar;
});
volume.addEventListener('input', () => setVolume(volume.value));
volume.addEventListener('change', () => {
  setVolume(volume.value);
  canvas.focus();
});

// Hooks for tools/web/smoke_test.mjs and the console.
window.__driftio = {
  pickArchive,
  loadCell,
  streamStats,
  assetStats: () => state.archive ? state.archive.stats() : null,
  textureProblems: () => textureProblems.slice(),
  get ready() { return state.ready; },
  get archive() { return state.archive; },
  get module() { return state.module; },
  get worker() { return state.pool; },
  screenshot() { return canvas.toDataURL('image/png'); },
  setTimeOfDay,
  setCar,
  setExposure,
  setVolume,
  volume: currentVolume,
  teleport(x, z) {
    return ccall('driftio_web_teleport', 'number', ['number', 'number'], [x, z]);
  },
  archiveInfo() {
    return { name: state.archiveName, size: state.archiveSize, entries: state.archive ? state.archive.list().length : 0 };
  },
  textureIssues() {
    const issues = state.textureIssues.slice();
    if (state.module && state.module.ccall) {
      const cpp = ccall('driftio_web_texture_failures', 'string', [], []);
      for (const line of String(cpp || '').split('\n')) {
        if (line && !issues.includes(line)) issues.push(line);
      }
    }
    return issues;
  },
  textureAvailable,
  textureAudit() {
    const issues = this.textureIssues();
    return {
      requests: state.module ? ccall('driftio_web_texture_requests', 'number', [], []) : 0,
      fallbacks: state.module ? ccall('driftio_web_texture_white_fallbacks', 'number', [], []) : 0,
      issues,
      problems: textureProblems.slice(),
    };
  },
};

loadModule().catch((error) => setError(error && error.message ? error.message : String(error)));
