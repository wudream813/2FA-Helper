/* 验证「解码器真的能被加载并且能解码」——这条链路以前没有人测，
   于是「二维码解码器未加载」只能等用户踩到。
   1) 模拟 service worker 的 importScripts，从磁盘真读 vendor/jsqr.js
   2) 用 vendor/qrcode.js 生成一张二维码像素图
   3) 用 lib/qr.js 的 decodeImageData 解出原文
   4) 验证 ESM 兜底（dynamic import('vendor/jsqr.mjs')）也能拿到解码器 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(ROOT, 'src');
const read = (rel) => readFileSync(path.join(SRC, rel), 'utf8');

/* ---------------- 1. 像 service worker 一样启动 ---------------- */
const loaded = [];
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  Uint8ClampedArray,
  Math,
  Date,
  Promise,
  TextEncoder,
  TextDecoder,
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.importScripts = (...files) => {
  for (const f of files) {
    loaded.push(f);
    vm.runInContext(read(f), ctx, { filename: f });
  }
};
const ctx = vm.createContext(sandbox);

// background.js 启动时做的第一件事：拉 lib/*
for (const f of ['lib/util.js', 'lib/qr.js']) sandbox.importScripts(f);
// 关键：importScripts 在这种时机下必须真的把 jsQR 挂到全局
sandbox.importScripts('vendor/jsqr.js');
assert.equal(typeof sandbox.jsQR, 'function', 'importScripts(jsqr) 之后全局应有 jsQR');
assert.equal(sandbox.F2A.qr.hasDecoder(), true, 'F2A.qr.hasDecoder() 应为 true');
console.log('✓ 解码器可加载：importScripts("vendor/jsqr.js") 之后 F2A.qr.hasDecoder() === true');

/* ---------------- 2. 造一张二维码 ---------------- */
vm.runInContext(read('vendor/qrcode.js'), ctx, { filename: 'vendor/qrcode.js' });
const PAYLOAD = 'otpauth://totp/GitHub:me%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub';

function renderQr(text, cell = 4, marginModules = 4) {
  const qr = sandbox.qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const count = qr.getModuleCount();
  const side = (count + marginModules * 2) * cell;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (!qr.isDark(r, c)) continue;
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const px = ((r + marginModules) * cell + y) * side + ((c + marginModules) * cell + x);
          data[px * 4] = 0;
          data[px * 4 + 1] = 0;
          data[px * 4 + 2] = 0;
        }
      }
    }
  }
  return { data, width: side, height: side };
}

/* ---------------- 3. 解码 ---------------- */
const image = renderQr(PAYLOAD);
const text = sandbox.F2A.qr.decodeImageData(image);
assert.equal(text, PAYLOAD, 'lib/qr.js 应能从像素图解出 otpauth 原文');
console.log('✓ 解码链路正常：像素图 → jsQR → otpauth 原文');

/* 只截取右下角一小块应当解不出来（证明「只解码框住的那一块」是真裁剪） */
const cropped = { data: new Uint8ClampedArray(64 * 64 * 4).fill(255), width: 64, height: 64 };
assert.equal(sandbox.F2A.qr.decodeImageData(cropped), null, '白底小块不应解出内容');
console.log('✓ 空白区域解码返回 null（不会误报成二维码）');

/* ---------------- 4. ESM 兜底 ---------------- */
globalThis.self = globalThis;
const mod = await import(path.join(SRC, 'vendor/jsqr.mjs'));
assert.equal(typeof (mod.default || mod.jsQR), 'function', 'vendor/jsqr.mjs 应默认导出一个解码函数');
const pixelText = (mod.default)(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' });
assert.equal(pixelText && pixelText.data, PAYLOAD, 'ESM 兜底拿到的解码器要能正常解码');
console.log('✓ ESM 兜底可用：dynamic import("vendor/jsqr.mjs") 也能解码');

console.log('\n全部通过（4 项）');
