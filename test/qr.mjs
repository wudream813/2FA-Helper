/**
 * 二维码编解码测试（Passkey/扫码导入的基础）
 *  - 用 vendor/qrcode-generator 生成，再用 vendor/jsqr 解码，覆盖多种内容与尺寸
 *  - 与 Python 的 qrcode 库（独立实现）交叉验证：它生成的图必须能被我们的解码器读出
 *  - 校验 toCanvas 的绘制结果与模块矩阵一致
 *   node test/qr.mjs
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

const ctx = vm.createContext({ console, Math, Date, Uint8ClampedArray, Uint8Array, Array, Error });
vm.runInContext(read('src/vendor/qrcode.js'), ctx);
vm.runInContext(read('src/vendor/jsqr.js'), ctx);
// qr.js expects F2A + btoa/atob/TextEncoder for util-free usage; give it the minimal surface
ctx.F2A = { bytesToB64: (u8) => Buffer.from(u8).toString('base64'), b64ToBytes: (s) => new Uint8Array(Buffer.from(s, 'base64')) };
ctx.window = ctx;
ctx.document = { createElement: () => ({ getContext: () => null }) };
vm.runInContext(read('src/lib/qr.js'), ctx);
const F2A = ctx.F2A;

let passed = 0;
const fails = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { fails.push(name); console.log('  ✗ ' + name + '\n      ' + e.message); }
}

/** Render the module matrix of a QR into RGBA (what a screenshot would look like). */
function renderModules(text, { scale = 4, quiet = 4, level = 'M' } = {}) {
  const qr = ctx.qrcode(0, level);
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const size = (n + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const x = (c + quiet) * scale + dx;
          const y = (r + quiet) * scale + dy;
          const i = (y * size + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
          data[i + 3] = 255;
        }
      }
    }
  }
  return { data, width: size, height: size, modules: n };
}

const PAYLOADS = {
  otpauth: 'otpauth://totp/GitHub:me@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&algorithm=SHA1&digits=6&period=30',
  migration: 'otpauth-migration://offline?data=CjEKCkhlbGxvId6tvu8SF21lQGV4YW1wbGUuY29tGgZHaXRIdWIgASgBMAIYASABKAA%3D',
  sync: 'f2a-sync:v1:' + 'JBSWY3DPEHPK3PXP'.repeat(2),
  passkey: 'f2a-passkey:v1:' + ctx.F2A.bytesToB64(new TextEncoder().encode(JSON.stringify({
    rpId: 'github.com', userName: 'me@example.com', credentialId: 'abc-123', algorithm: -7,
  }))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
};

console.log('\n二维码编解码');

for (const [name, payload] of Object.entries(PAYLOADS)) {
  await test(`编码→解码往返：${name}`, () => {
    const img = renderModules(payload);
    const text = F2A.qr.decodeImageData(img);
    assert.equal(text, payload);
  });
}

await test('低分辨率（2px/模块）也能解出', () => {
  const img = renderModules(PAYLOADS.otpauth, { scale: 2 });
  assert.equal(F2A.qr.decodeImageData(img), PAYLOADS.otpauth);
});

await test('高纠错等级 H 且内容较长', () => {
  const long = 'otpauth://totp/Big%20Service:someone.with.a.long.address@example-corporation.com?secret=' + 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Big%20Service&digits=8&period=60&algorithm=SHA512';
  const img = renderModules(long, { level: 'H', scale: 3 });
  assert.equal(F2A.qr.decodeImageData(img), long);
});

await test('空图片返回 null 而不是抛错', () => {
  const blank = { data: new Uint8ClampedArray(200 * 200 * 4).fill(255), width: 200, height: 200 };
  assert.equal(F2A.qr.decodeImageData(blank), null);
});

await test('toCanvas 绘制结果与模块矩阵一致', () => {
  const fills = [];
  const fakeCanvas = {
    width: 0, height: 0, style: {},
    getContext: () => ({
      setTransform() {}, scale() {},
      set fillStyle(v) { this._fill = v; }, get fillStyle() { return this._fill; },
      fillRect(x, y, w, h) { fills.push({ fill: this._fill, x, y, w, h }); },
    }),
  };
  const size = F2A.qr.toCanvas(fakeCanvas, PAYLOADS.otpauth, { size: 200, margin: 2 });
  const qr = ctx.qrcode(0, 'M');
  qr.addData(PAYLOADS.otpauth, 'Byte');
  qr.make();
  let dark = 0;
  for (let r = 0; r < qr.getModuleCount(); r++) {
    for (let c = 0; c < qr.getModuleCount(); c++) if (qr.isDark(r, c)) dark++;
  }
  const white = fills.filter((f) => f.fill === '#ffffff');
  const black = fills.filter((f) => f.fill === '#000000');
  assert.equal(white.length, 1, '应先铺一层白底（深色模式下也能扫）');
  assert.equal(black.length, dark, '黑块数量应等于暗模块数量');
  assert.ok(size >= 200 * 0.8, '尺寸不应明显小于请求值: ' + size);
  assert.ok(black.every((b) => b.w === black[0].w && b.w > 0), '模块应为等宽方块');
});

await test('与 Python qrcode 库交叉验证（独立实现）', () => {
  let ok = false;
  try {
    execFileSync('python3', ['-c', `
import qrcode, sys, json
payloads = json.loads(sys.argv[1])
for i, p in enumerate(payloads):
    qrcode.make(p).save(f'/tmp/xqr{i}.png')
`, JSON.stringify([PAYLOADS.otpauth, PAYLOADS.passkey])]);
    ok = true;
  } catch (e) {
    console.log('      （跳过：本机没有 python qrcode 库）');
  }
  if (!ok) return;
  for (let i = 0; i < 2; i++) {
    const png = PNG.sync.read(readFileSync(`/tmp/xqr${i}.png`));
    const text = F2A.qr.decodeImageData({ data: new Uint8ClampedArray(png.data), width: png.width, height: png.height });
    assert.equal(text, [PAYLOADS.otpauth, PAYLOADS.passkey][i], 'Python 生成的二维码应能被解码');
  }
});

console.log(`\n${fails.length ? '✗' : '✓'} ${passed} passed, ${fails.length} failed\n`);
if (fails.length) process.exit(1);
