// Main-thread side of the asset worker. The page keeps only this manifest;
// every byte read, decompression and cache lives in the worker.

function normalize(path) {
  return String(path || '').replace(/^\/+/, '');
}

export class AssetClient {
  constructor() {
    const debug = new URLSearchParams(location.search).has('debug');
    this.worker = new Worker(new URL(`./asset-worker.js${debug ? '?debug=1' : ''}`, import.meta.url), { type: 'module' });
    this.nextId = 1;
    this.pending = new Map();
    this.manifest = new Map();
    this.prefix = '';
    this.archiveSize = 0;
    this.cacheBytes = 0;
    this.mainBytes = 0;
    this.mainReads = 0;
    this.worker.onmessage = (event) => {
      const reply = event.data || {};
      if (reply.id === undefined) {
        if (reply.type === 'cache') this.cacheBytes = reply.bytes || 0;
        return;
      }
      const job = this.pending.get(reply.id);
      if (!job) return;
      this.pending.delete(reply.id);
      if (reply.ok) job.resolve(reply);
      else job.reject(new Error(reply.error || 'asset worker failed'));
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message || 'asset worker failed');
      for (const job of this.pending.values()) job.reject(error);
      this.pending.clear();
    };
  }

  request(message, transfer = []) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, ...message }, transfer);
    });
  }

  async open(file) {
    const reply = await this.request({ type: 'open', file });
    this.manifest = new Map((reply.names || []).map((name) => [name, reply.sizes[name] || 0]));
    this.prefix = reply.prefix || '';
    this.archiveSize = reply.archiveSize || file.size;
    return {
      names: reply.names || [],
      prefix: this.prefix,
      archiveSize: this.archiveSize,
    };
  }

  has(path) {
    return this.manifest.has(normalize(path));
  }

  size(path) {
    return this.manifest.get(normalize(path)) || 0;
  }

  list() {
    return [...this.manifest.keys()];
  }

  async bytes(path) {
    const reply = await this.request({ type: 'read', path: normalize(path) });
    this.mainBytes += reply.bytes.byteLength;
    this.mainReads += 1;
    return reply.bytes;
  }

  async text(path) {
    return new TextDecoder().decode(await this.bytes(path));
  }

  connect(targetWorker, target) {
    const { port1, port2 } = new MessageChannel();
    this.worker.postMessage({ type: 'connect', target, port: port2 }, [port2]);
    targetWorker.postMessage({ type: 'connectAsset', port: port1 }, [port1]);
    return port1;
  }

  stats() {
    return {
      prefix: this.prefix,
      entries: this.manifest.size,
      archiveSize: this.archiveSize,
      cacheBytes: this.cacheBytes,
      mainBytes: this.mainBytes,
      mainReads: this.mainReads,
      pending: this.pending.size,
    };
  }

  terminate() {
    this.worker.terminate();
    this.pending.clear();
  }
}
