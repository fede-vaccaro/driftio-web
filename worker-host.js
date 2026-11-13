// Main-thread side of the parser workers (plans/web/wasm-web-build.md, phases
// 3.5 and 5.7): a small pool, a job queue per worker, transferred buffers in
// and out. Jobs that name a cache key stick to one worker so each worker's
// parsed-geometry cache keeps its hits.

class WorkerHost {
  constructor() {
    this.worker = new Worker(new URL('./worker-main.js', import.meta.url), { type: 'module' });
    this.nextId = 1;
    this.pending = new Map();
    this.failed = null;
    this.worker.onmessage = (event) => {
      const reply = event.data;
      const job = this.pending.get(reply.id);
      if (!job) return;
      this.pending.delete(reply.id);
      if (reply.ok) job.resolve(reply);
      else job.reject(new Error(reply.error || 'worker parse failed'));
    };
    this.worker.onerror = (event) => {
      const error = new Error(`parser worker failed: ${event.message || 'unknown error'}`);
      this.failed = error;
      for (const job of this.pending.values()) job.reject(error);
      this.pending.clear();
    };
  }

  // {obj, mtl, baseDir, matrices, needCollision, cacheKey, needModel}
  // -> {model, collision, textures}
  parse(job) {
    if (this.failed) return Promise.reject(this.failed);
    // The ZIP cache owns the original bytes, so send copies (a transfer would
    // detach both the cache entry and the next cell's parse input).
    const obj = job.obj.slice();
    const mtl = job.mtl ? job.mtl.slice() : new Uint8Array(0);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const transfer = [obj.buffer];
      if (mtl.length) transfer.push(mtl.buffer);
      this.worker.postMessage({ id, ...job, obj, mtl }, transfer);
    });
  }

  parseAsset(job) {
    if (this.failed) return Promise.reject(this.failed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type: 'objAsset', ...job });
    });
  }

  bundle(job) {
    if (this.failed) return Promise.reject(this.failed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type: 'bundle', ...job });
    });
  }

  connectAsset(port) {
    this.worker.postMessage({ type: 'connectAsset', port }, [port]);
  }

  forget(key) {
    if (this.failed) return;
    this.worker.postMessage({ type: 'forget', key });
  }

  get pendingCount() {
    return this.pending.size;
  }

  get alive() {
    return this.failed === null;
  }

  terminate() {
    this.worker.terminate();
    this.pending.clear();
    this.failed = new Error('worker terminated');
  }
}

export class WorkerPool {
  constructor(asset = null, count = 2) {
    this.workers = Array.from({ length: Math.max(1, count) }, () => new WorkerHost());
    this.affinity = new Map();  // cache key -> worker
    if (asset) {
      for (const host of this.workers) {
        const { port1, port2 } = new MessageChannel();
        asset.worker.postMessage({ type: 'connect', target: 'parser', port: port2 }, [port2]);
        host.connectAsset(port1);
      }
    }
  }

  // Prefer the worker that already parsed this model; otherwise the least busy.
  parse(job) {
    const key = job.cacheKey || '';
    let host = key ? this.affinity.get(key) : null;
    if (!host || !host.alive) {
      const alive = this.workers.filter((w) => w.alive);
      if (!alive.length) return Promise.reject(new Error('all parser workers failed'));
      host = alive.reduce((a, b) => (a.pendingCount <= b.pendingCount ? a : b));
      if (key) this.affinity.set(key, host);
    }
    return host.parse(job);
  }

  parseAsset(job) {
    const key = job.cacheKey || '';
    let host = key ? this.affinity.get(key) : null;
    if (!host || !host.alive) {
      const alive = this.workers.filter((w) => w.alive);
      if (!alive.length) return Promise.reject(new Error('all parser workers failed'));
      host = alive.reduce((a, b) => (a.pendingCount <= b.pendingCount ? a : b));
      if (key) this.affinity.set(key, host);
    }
    return host.parseAsset(job);
  }

  bundle(job) {
    const key = job.cacheKey || '';
    let host = key ? this.affinity.get(key) : null;
    if (!host || !host.alive) {
      const alive = this.workers.filter((w) => w.alive);
      if (!alive.length) return Promise.reject(new Error('all parser workers failed'));
      host = alive.reduce((a, b) => (a.pendingCount <= b.pendingCount ? a : b));
      if (key) this.affinity.set(key, host);
    }
    return host.bundle(job);
  }

  forget(key) {
    for (const worker of this.workers) worker.forget(key);
    this.affinity.delete(key);
  }

  get pendingCount() {
    return this.workers.reduce((sum, w) => sum + w.pendingCount, 0);
  }

  terminate() {
    for (const worker of this.workers) worker.terminate();
    this.affinity.clear();
  }
}
