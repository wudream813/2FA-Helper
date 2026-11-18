/* 2FA Helper — QR helpers on top of the vendored jsQR (decode) and
   qrcode-generator (encode). Kept in its own file so the popup only pays for
   the decoder when it actually scans. */
(function (root) {
  'use strict';
  const F2A = (root.F2A = root.F2A || {});

  function hasEncoder() { return typeof root.qrcode === 'function'; }
  function hasDecoder() { return typeof root.jsQR === 'function'; }

  /** Render `text` as a QR into a <canvas>; returns the CSS pixel size. */
  function toCanvas(canvas, text, opts = {}) {
    if (!hasEncoder()) throw new Error('二维码生成器未加载');
    const level = opts.level || 'M';
    const qr = root.qrcode(0, level);
    qr.addData(String(text), 'Byte');
    qr.make();
    const count = qr.getModuleCount();
    const margin = opts.margin == null ? 2 : opts.margin;
    const cell = Math.max(2, Math.floor((opts.size || 220) / (count + margin * 2)));
    const px = cell * (count + margin * 2);
    const ctx = canvas.getContext('2d');
    const dpr = root.devicePixelRatio || 1;
    canvas.width = Math.round(px * dpr);
    canvas.height = Math.round(px * dpr);
    canvas.style.width = px + 'px';
    canvas.style.height = px + 'px';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    // always paint a light background: dark-mode pages would otherwise break scanning
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = '#000000';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) ctx.fillRect((c + margin) * cell, (r + margin) * cell, cell, cell);
      }
    }
    return px;
  }

  /** Decode an ImageData-like object ({data,width,height}). */
  function decodeImageData(imageData) {
    if (!hasDecoder()) throw new Error('二维码解码器未加载');
    const result = root.jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' });
    return result ? result.data : null;
  }

  /** Draw any image source (img/canvas/video) into a canvas and return ImageData. */
  function grabImageData(source, opts = {}) {
    const max = opts.max || 1400;
    const w0 = source.videoWidth || source.naturalWidth || source.width;
    const h0 = source.videoHeight || source.naturalHeight || source.height;
    if (!w0 || !h0) throw new Error('图片尚未加载完成');
    const scale = Math.min(1, max / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));
    const canvas = opts.canvas || root.document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  /** Load a File/Blob into an <img> (no object URL leak). */
  async function fileToImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('图片无法解析（支持 png/jpg/webp/gif/bmp）'));
        img.src = url;
      });
      return img;
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }

  async function decodeFile(file) {
    const img = await fileToImage(file);
    return decodeImageData(grabImageData(img));
  }

  Object.assign(F2A, { qr: { hasEncoder, hasDecoder, toCanvas, decodeImageData, grabImageData, decodeFile, fileToImage } });
})(typeof globalThis !== 'undefined' ? globalThis : self);
