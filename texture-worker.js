// Off-main texture decode for the web streamer: the asset worker supplies the
// encoded PNG/JPEG bytes, this worker returns raw RGBA.
//
// Decode through WebGL, not a 2D canvas. Several of the game's PNGs carry data
// in their alpha channel (ground masks, normal maps): drawing them to a 2D
// canvas premultiplies RGB by alpha, so every alpha-0 texel would come back
// black and the layer mask would lose most of its values. A WebGL texture with
// UNPACK_PREMULTIPLY_ALPHA_WEBGL = false keeps the source bytes, and readPixels
// returns them bottom row first, the layout the engine uploads.
//
// One canvas/context per worker, reused for every decode: a fresh WebGL context
// per texture hits the browser's context limit and loses the oldest ones.

let canvas = null;
let gl = null;
let assetPort = null;
let nextReadId = 1;
const pendingReads = new Map();

function decodeContext() {
  if (!gl) {
    canvas = new OffscreenCanvas(1, 1);
    gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      depth: false,
      stencil: false,
    });
    if (!gl) throw new Error('OffscreenCanvas has no WebGL2 context');
  }
  return gl;
}

function requestBytes(path) {
  if (!assetPort) return Promise.reject(new Error('texture worker has no asset port'));
  const readId = nextReadId++;
  return new Promise((resolve, reject) => {
    pendingReads.set(readId, { resolve, reject });
    assetPort.postMessage({ type: 'read', readId, path });
  });
}

async function decodeBytes(bytes) {
  let framebuffer = null;
  let texture = null;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes]), {
      imageOrientation: 'flipY',
      premultiplyAlpha: 'none',
    });
    const width = bitmap.width;
    const height = bitmap.height;
    const gl = decodeContext();
    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);

    texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    bitmap.close();

    framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('texture decode framebuffer is incomplete');
    }
    const rgba = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { width, height, rgba: rgba.buffer };
  } finally {
    if (gl) {
      if (framebuffer) gl.deleteFramebuffer(framebuffer);
      if (texture) gl.deleteTexture(texture);
    }
  }
}

self.onmessage = async (event) => {
  const data = event.data || {};
  if (data.type === 'connectAsset') {
    assetPort = data.port;
    assetPort.onmessage = (message) => {
      const reply = message.data || {};
      const job = pendingReads.get(reply.readId);
      if (!job) return;
      pendingReads.delete(reply.readId);
      if (reply.ok) job.resolve(reply.bytes);
      else job.reject(new Error(reply.error || 'asset read failed'));
    };
    return;
  }
  const { id, path } = data;
  try {
    const bytes = await requestBytes(path);
    const encoded = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes
      : bytes.slice();
    const image = await decodeBytes(bytes);
    self.postMessage({ id, ok: true, ...image, bytes: encoded }, [image.rgba, encoded.buffer]);
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error && error.message ? error.message : error) });
  }
};
