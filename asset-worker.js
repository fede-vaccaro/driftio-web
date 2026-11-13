// The asset worker's JS glue: owns the picked File, answers byte-range
// requests from the WASM ZIP reader, and routes compressed entries to the
// parser and texture workers. No archive bytes pass through the main page.

import createDriftioAssetsWorker from './driftio_assets_worker.js';

const modulePromise = createDriftioAssetsWorker({
  locateFile: (path) => new URL(path, import.meta.url).href,
});

let file = null;
let prefix = '';
let manifest = new Map();
let serial = Promise.resolve();
const ports = new Map();

function normalize(name) {
  return String(name || '').replace(/^\/+/, '');
}

function archiveRoot(names) {
  const hasAssets = names.some((n) => n === 'assets' || n.startsWith('assets/'));
  if (hasAssets) return '';
  const withAssets = names.find((n) => n.includes('/assets/'));
  if (!withAssets) return null;
  const candidate = withAssets.slice(0, withAssets.indexOf('/assets/') + 1);
  return names.every((n) => n.startsWith(candidate)) ? candidate : null;
}

async function readRange(offset, length) {
  const end = offset + length;
  return new Uint8Array(await file.slice(offset, end).arrayBuffer());
}

function moduleError(mod) {
  return mod.ccall('driftio_asset_error', 'string', [], []) || 'asset worker failed';
}

function feed(mod, bytes) {
  const ptr = mod._malloc(Math.max(1, bytes.length));
  try {
    if (bytes.length) mod.HEAPU8.set(bytes, ptr);
    const ok = mod.ccall('driftio_asset_feed', 'number', ['number', 'number'], [ptr, bytes.length]);
    if (!ok) throw new Error(moduleError(mod));
  } finally {
    mod._free(ptr);
  }
}

async function driveRequests(mod) {
  for (;;) {
    const kind = mod.ccall('driftio_asset_next_request', 'number', [], []);
    if (!kind) return;
    const offset = mod.ccall('driftio_asset_request_offset', 'number', [], []);
    const length = mod.ccall('driftio_asset_request_length', 'number', [], []);
    const bytes = await readRange(offset, length);
    feed(mod, bytes);
  }
}

function parseManifest(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    if (!line) continue;
    const [name, size, compressed, method] = line.split('\t');
    out.set(name, {
      name,
      size: Number(size),
      compressed: Number(compressed),
      method: Number(method),
    });
  }
  return out;
}

async function open(fileObject) {
  file = fileObject;
  const mod = await modulePromise;
  const tailLength = Math.min(file.size, 65557 + 20);
  const tail = await readRange(file.size - tailLength, tailLength);
  const ptr = mod._malloc(Math.max(1, tail.length));
  try {
    if (tail.length) mod.HEAPU8.set(tail, ptr);
    const ok = mod.ccall('driftio_asset_open_tail', 'number', ['number', 'number', 'number'],
      [file.size, ptr, tail.length]);
    if (!ok) throw new Error(moduleError(mod));
  } finally {
    mod._free(ptr);
  }
  await driveRequests(mod);
  const all = parseManifest(mod.ccall('driftio_asset_manifest', 'string', [], []));
  const root = archiveRoot([...all.keys()]);
  if (root === null) throw new Error('this ZIP has no assets/ folder');
  prefix = root;
  manifest = new Map();
  for (const [name, entry] of all) {
    const stripped = name.startsWith(prefix) ? name.slice(prefix.length) : name;
    manifest.set(stripped, { ...entry, name: stripped, archiveName: name });
  }
  return {
    names: [...manifest.keys()],
    sizes: Object.fromEntries([...manifest].map(([name, entry]) => [name, entry.size])),
    prefix,
    archiveSize: file.size,
  };
}

async function readEntry(path) {
  const started = performance.now();
  const mod = await modulePromise;
  const key = normalize(path);
  const entry = manifest.get(key);
  if (!entry) throw new Error(`missing archive entry '${path}'`);
  const ok = mod.ccall('driftio_asset_request_entry', 'number', ['string'], [entry.archiveName]);
  if (!ok) throw new Error(moduleError(mod));
  await driveRequests(mod);
  const ptr = mod.ccall('driftio_asset_entry_data', 'number', [], []);
  const size = mod.ccall('driftio_asset_entry_size', 'number', [], []);
  if (size < 0 || (size > 0 && !ptr)) throw new Error(`empty archive entry '${path}'`);
  const bytes = size > 0 ? mod.HEAPU8.slice(ptr, ptr + size) : new Uint8Array(0);
  if (self.location && self.location.search.includes('debug')) {
    console.log('driftio: asset read', path, size, Math.round(performance.now() - started), 'ms');
  }
  return bytes;
}

function enqueue(task) {
  const run = serial.then(task, task);
  serial = run.catch(() => {});
  return run;
}

function workerRead(port, request) {
  enqueue(async () => {
    try {
      const bytes = await readEntry(request.path);
      port.postMessage({ readId: request.readId, ok: true, bytes }, [bytes.buffer]);
    } catch (error) {
      port.postMessage({
        readId: request.readId,
        ok: false,
        error: error && error.message ? error.message : String(error),
      });
    }
  });
}

self.onmessage = (event) => {
  const data = event.data || {};
  if (data.type === 'open') {
    enqueue(async () => {
      try {
        const opened = await open(data.file);
        self.postMessage({ id: data.id, ok: true, ...opened });
      } catch (error) {
        self.postMessage({
          id: data.id,
          ok: false,
          error: error && error.message ? error.message : String(error),
        });
      }
    });
    return;
  }
  if (data.type === 'read') {
    enqueue(async () => {
      try {
        const bytes = await readEntry(data.path);
        self.postMessage({ id: data.id, ok: true, bytes }, [bytes.buffer]);
      } catch (error) {
        self.postMessage({
          id: data.id,
          ok: false,
          error: error && error.message ? error.message : String(error),
        });
      }
    });
    return;
  }
  if (data.type === 'connect') {
    const port = data.port;
    ports.set(data.target, port);
    port.onmessage = (message) => {
      const request = message.data || {};
      if (request.type === 'read') workerRead(port, request);
    };
    port.postMessage({ type: 'connected', target: data.target });
  }
};

setInterval(() => {
  modulePromise.then((mod) => {
    const bytes = mod.ccall('driftio_asset_cache_bytes', 'number', [], []);
    self.postMessage({ type: 'cache', bytes });
    for (const port of ports.values()) port.postMessage({ type: 'cache', bytes });
  });
}, 5000);
