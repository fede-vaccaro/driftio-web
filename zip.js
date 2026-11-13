// A lazy ZIP reader for the picked assets archive (plans/web/wasm-web-build.md
// 2.1). It reads the central directory only, then slices and decompresses the
// entries a caller asks for: the 1 GB archive is never loaded whole.

const EOCD = 0x06054b50;
const ZIP64_EOCD = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

function normalize(name) {
  const out = [];
  for (const part of name.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function u64(view, offset) {
  return Number(view.getBigUint64(offset, true));
}

export class ZipArchive {
  constructor(file) {
    this.file = file;
    this.entries = new Map();
    // Shared OBJ/MTL/texture entries are asked for by every cell that uses
    // them; decompressing them again is pure waste. An LRU of the bytes also
    // keeps the transfer to the parser worker cheap (see worker-host.js).
    this.cache = new Map();
    this.cacheBytes = 0;
    this.cacheLimit = 192 * 1024 * 1024;
  }

  static async open(file) {
    const zip = new ZipArchive(file);
    await zip._readDirectory();
    return zip;
  }

  async _readDirectory() {
    const size = this.file.size;
    const tailLength = Math.min(size, 65557 + 20);
    const tailStart = size - tailLength;
    const tail = new DataView(await this.file.slice(tailStart).arrayBuffer());

    let eocd = -1;
    for (let i = tail.byteLength - 22; i >= 0; --i) {
      if (tail.getUint32(i, true) === EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('not a ZIP archive (no end-of-central-directory record)');

    let count = tail.getUint16(eocd + 10, true);
    let directorySize = tail.getUint32(eocd + 12, true);
    let directoryOffset = tail.getUint32(eocd + 16, true);

    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      const eocdAbsolute = tailStart + eocd;
      const locator = new DataView(await this.file.slice(eocdAbsolute - 20, eocdAbsolute).arrayBuffer());
      if (locator.getUint32(0, true) !== ZIP64_LOCATOR) throw new Error('damaged ZIP64 locator');
      const zip64Offset = u64(locator, 8);
      const zip64 = new DataView(await this.file.slice(zip64Offset, zip64Offset + 56).arrayBuffer());
      if (zip64.getUint32(0, true) !== ZIP64_EOCD) throw new Error('damaged ZIP64 directory record');
      count = u64(zip64, 32);
      directorySize = u64(zip64, 40);
      directoryOffset = u64(zip64, 48);
    }

    const directory = new DataView(await this.file.slice(directoryOffset, directoryOffset + directorySize).arrayBuffer());
    const decoder = new TextDecoder('utf-8');
    let offset = 0;
    for (let i = 0; i < count; ++i) {
      if (directory.getUint32(offset, true) !== CENTRAL) throw new Error('damaged ZIP central directory');
      const flags = directory.getUint16(offset + 8, true);
      const method = directory.getUint16(offset + 10, true);
      let compressedSize = directory.getUint32(offset + 20, true);
      let uncompressedSize = directory.getUint32(offset + 24, true);
      const nameLength = directory.getUint16(offset + 28, true);
      const extraLength = directory.getUint16(offset + 30, true);
      const commentLength = directory.getUint16(offset + 32, true);
      let localOffset = directory.getUint32(offset + 42, true);
      const name = normalize(decoder.decode(new Uint8Array(directory.buffer, offset + 46, nameLength)));

      let extra = offset + 46 + nameLength;
      const extraEnd = extra + extraLength;
      while (extra + 4 <= extraEnd) {
        const id = directory.getUint16(extra, true);
        const length = directory.getUint16(extra + 2, true);
        if (id === 0x0001) {
          let p = extra + 4;
          if (uncompressedSize === 0xffffffff) {
            uncompressedSize = u64(directory, p);
            p += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = u64(directory, p);
            p += 8;
          }
          if (localOffset === 0xffffffff) localOffset = u64(directory, p);
        }
        extra += 4 + length;
      }

      this.entries.set(name, {
        name, method, flags, compressedSize, uncompressedSize, localOffset,
      });
      offset += 46 + nameLength + extraLength + commentLength;
    }
  }

  list() {
    return [...this.entries.keys()];
  }

  has(name) {
    return this.entries.has(normalize(name));
  }

  size(name) {
    const entry = this.entries.get(normalize(name));
    return entry ? entry.uncompressedSize : 0;
  }

  compressedSize(name) {
    const entry = this.entries.get(normalize(name));
    return entry ? entry.compressedSize : 0;
  }

  _cacheGet(key) {
    const bytes = this.cache.get(key);
    if (!bytes) return null;
    this.cache.delete(key);  // LRU: refresh to the end
    this.cache.set(key, bytes);
    return bytes;
  }

  _cachePut(key, bytes) {
    if (bytes.length > this.cacheLimit / 4) return;  // one huge entry would evict everything
    if (this.cache.has(key)) {
      this.cacheBytes -= this.cache.get(key).length;
      this.cache.delete(key);
    }
    this.cache.set(key, bytes);
    this.cacheBytes += bytes.length;
    while (this.cacheBytes > this.cacheLimit) {
      const oldest = this.cache.keys().next().value;
      this.cacheBytes -= this.cache.get(oldest).length;
      this.cache.delete(oldest);
    }
  }

  async bytes(name) {
    const key = normalize(name);
    const cached = this._cacheGet(key);
    if (cached) return cached;
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`missing archive entry '${name}'`);
    const header = new DataView(await this.file.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
    if (header.getUint32(0, true) !== LOCAL) throw new Error(`damaged local header for '${name}'`);
    const nameLength = header.getUint16(26, true);
    const extraLength = header.getUint16(28, true);
    const start = entry.localOffset + 30 + nameLength + extraLength;
    const slice = this.file.slice(start, start + entry.compressedSize);
    let bytes;
    if (entry.method === 0) {
      bytes = new Uint8Array(await slice.arrayBuffer());
    } else if (entry.method === 8) {
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('this browser cannot decompress deflate entries (no DecompressionStream)');
      }
      const stream = slice.stream().pipeThrough(new DecompressionStream('deflate-raw'));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } else {
      throw new Error(`unsupported ZIP compression method ${entry.method} for '${name}'`);
    }
    this._cachePut(key, bytes);
    return bytes;
  }
}
