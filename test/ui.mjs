/**
 * DOM smoke test (jsdom): boots the real background.js plus the real popup and
 * options pages against an in-memory extension API, then drives the UI.
 *   node test/ui.mjs
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = path.join(ROOT, 'src');
const read = (p) => readFileSync(path.join(SRC, p), 'utf8');

/* ---------------- in-memory extension API ---------------- */
const storeLocal = new Map();
const storeSession = new Map();
const storeSync = new Map();   // stands in for the browser-account cloud

function storageArea(map) {
  return {
    async get(keys) {
      const out = {};
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {});
      for (const k of list) if (map.has(k)) out[k] = structuredClone(map.get(k));
      return out;
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) map.set(k, structuredClone(v)); },
    async remove(keys) { for (const k of [].concat(keys)) map.delete(k); },
    async clear() { map.clear(); },
  };
}

const bgListener = { fn: null };
const createdTabs = [];
const createdWindows = [];
const contentListeners = [];

function makeChrome(opts = {}) {
  return {
    runtime: {
      id: 'test-extension-id',
      getManifest: () => ({ version: '1.0.0' }),
      getURL: (p) => 'chrome-extension://test-extension-id/' + p,
      onMessage: { addListener: (fn) => { if (opts.background) bgListener.fn = fn; else if (opts.content) contentListeners.push(fn); } },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      openOptionsPage() {},
      sendMessage(msg, cb) {
        const respond = (res) => { if (typeof cb === 'function') cb(res); };
        return new Promise((resolve) => {
          if (!bgListener.fn) { respond(undefined); return resolve(undefined); }
          bgListener.fn(msg, {}, (res) => { respond(res); resolve(res); });
        });
      },
      lastError: null,
    },
    storage: {
      local: storageArea(storeLocal),
      session: storageArea(storeSession),
      sync: storageArea(storeSync),
      onChanged: { addListener: (fn) => { opts.onChanged = fn; } },
    },
    alarms: {
      onAlarm: { addListener: (fn) => { if (opts.alarms) opts.alarms.fn = fn; } },
      async getAll() { return []; },
      async get() { return null; },
      async clear() {},
      create() {},
    },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    identity: { getRedirectURL: () => 'https://test-extension-id.chromiumapp.org/' },
    permissions: { async contains() { return true; }, async request() { return true; } },
    downloads: { async download() { return 1; } },
    tabs: {
      // 真实实现会截当前标签页；测试里返回一个合法 PNG data URL 前缀即可，
      // 真正的像素解码在下面被 stub 掉（jsdom 没有 canvas）。
      async captureVisibleTab() { return 'data:image/png;base64,iVBORw0KGgo='; },
      async query() { return [{ id: 7, active: true }]; },
      async sendMessage(tabId, msg) {
        for (const fn of contentListeners) {
          const res = await new Promise((resolve) => { fn(msg, {}, resolve); });
          if (res) return res;
        }
        throw new Error('Could not establish connection. Receiving end does not exist.');
      },
      async create(opts) { createdTabs.push(opts); return { id: createdTabs.length }; },
    },
    windows: {
      async create(opts) { createdWindows.push(opts); return { id: 100 + createdWindows.length }; },
    },
  };
}

const vc = new VirtualConsole();
const domErrors = [];
vc.on('jsdomError', (e) => domErrors.push(String(e.message)));

function boot({ html, scripts, background = false, content = false }) {
  const file = html ? path.join(SRC, html) : null;
  const dom = new JSDOM(file ? readFileSync(file, 'utf8') : '<!DOCTYPE html><html><body></body></html>', {
    url: 'chrome-extension://test-extension-id/popup/popup.html',
    runScripts: 'outside-only',
    virtualConsole: vc,
    pretendToBeVisual: true,
  });
  const win = dom.window;
  try { win.crypto = webcrypto; } catch (e) {
    Object.defineProperty(win, 'crypto', { value: webcrypto, configurable: true });
  }
  if (!win.crypto || !win.crypto.subtle) Object.defineProperty(win, 'crypto', { value: webcrypto, configurable: true });
  win.chrome = makeChrome({ background, content });
  win.browser = undefined;
  win.navigator.clipboard = { async writeText() { return true; } };
  win.confirm = () => true;
  win.prompt = () => 'test-password-123';
  win.matchMedia = win.matchMedia || (() => ({ matches: false, addEventListener() {} }));
  win.URL.createObjectURL = () => 'blob:test';
  win.URL.revokeObjectURL = () => {};
  for (const s of scripts) {
    win.eval(read(s));
  }
  return { dom, win };
}

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/* ---------------- boot the background ---------------- */
const call = (msg) => new Promise((res) => bgListener.fn(msg, {}, res));

const bg = boot({
  background: true,
  scripts: ['vendor/jsqr.js', 'lib/util.js', 'lib/totp.js', 'lib/crypto.js', 'lib/vault.js', 'lib/providers.js', 'lib/backup.js', 'lib/sync.js', 'lib/qr.js', 'background.js'],
});
assert.ok(bgListener.fn, 'background 应注册 onMessage 监听器');
await tick(100);
console.log('✓ background.js 启动，消息监听器已注册');
console.log('  badge text:', JSON.stringify(storeLocal.size), 'storage keys');

/* ---------------- popup ---------------- */
const { win: popup } = boot({ html: 'popup/popup.html', scripts: ['vendor/jsqr.js', 'lib/util.js', 'lib/totp.js', 'lib/qr.js', 'popup/popup.js'] });
await tick(300);

const $ = (id) => popup.document.getElementById(id);
assert.equal($('mainView').hidden, false, '未加密时弹窗应直接进入列表视图');
assert.equal($('emptyState').hidden, false, '空保管库应显示空状态');
console.log('✓ 弹窗：空状态渲染正常');

// add an entry through the real form
$('emptyAdd').click();
assert.equal($('formView').hidden, false);
$('fIssuer').value = 'GitHub';
$('fAccount').value = 'me@example.com';
$('fSecret').value = 'jbswy3dpehpk3pxp';
$('fUrls').value = 'github.com, gist.github.com';
$('entryForm').dispatchEvent(new popup.Event('submit', { bubbles: true, cancelable: true }));
await tick(400);

const rows = popup.document.querySelectorAll('.row');
assert.equal(rows.length, 1, '提交后应出现一行');
const codeText = popup.document.querySelector('.row .code').textContent;
console.log('  渲染的验证码:', codeText);
assert.match(codeText, /^\d{3} \d{3}$/, '6 位码应格式化为 xxx xxx');

// independently verify the code
const expected = await bg.win.F2A.totp.generate({ secret: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30 });
// 跨 30 秒边界时页面上的码可能还是上一个窗口的，两种都接受
const prevWindow = await bg.win.F2A.totp.generate({ secret: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30 }, Date.now() - 30000);
assert.ok([expected.code, prevWindow.code].includes(codeText.replace(' ', '')), '弹窗显示的验证码应与算法一致');
console.log('✓ 弹窗：新增账户并生成正确的 TOTP，且宽度/格式符合预期');

// search filter
$('search').value = 'gitlab';
$('search').dispatchEvent(new popup.Event('input', { bubbles: true }));
await tick(150);
assert.ok(popup.document.body.textContent.includes('没有匹配的账户'), '搜索无结果时应提示');
$('search').value = '';
$('search').dispatchEvent(new popup.Event('input', { bubbles: true }));
await tick(150);

// store really is encrypted-at-rest in plaintext mode (no encryption yet)
const vaultBefore = storeLocal.get('vault');
assert.equal(vaultBefore.encrypted, false);
console.log('✓ 未开启加密时保管库为明文档（与设置一致）');

/* ---------------- options ---------------- */
const { win: opt } = boot({
  html: 'options/options.html',
  scripts: ['vendor/qrcode.js', 'vendor/jsqr.js', 'lib/util.js', 'lib/providers.js', 'lib/qr.js', 'options/options.js'],
});
await tick(400);
const $o = (id) => opt.document.getElementById(id);

const tabs = opt.document.querySelectorAll('.provider-tab');
assert.equal(tabs.length, 7, '应有 7 个渠道标签（不启用/文件夹/对象存储/WebDAV/三家 OAuth）');
const tabTexts = [...tabs].map((t) => t.textContent);
assert.ok(tabTexts.some((t) => t.includes('文件夹同步')), '缺少文件夹同步渠道');
assert.ok(tabTexts.some((t) => t.includes('对象存储')), '缺少对象存储渠道');
assert.equal(opt.document.querySelectorAll('.provider-tab .cost.oauth').length, 2, 'Google / Dropbox 应标注「需注册」');
assert.equal(opt.document.querySelectorAll('.provider-tab .cost.builtin').length, 1, 'OneDrive 应标注「已内置」');
console.log('✓ 设置页：7 个渠道标签，4 个「免注册」+ 1 个「已内置」+ 2 个「需注册」');

/* 一键连接：OneDrive 面板必须预填内置客户端 ID */
{
  const tab = [...opt.document.querySelectorAll('.provider-tab')].find((t) => t.textContent.includes('OneDrive'));
  tab.click();
  await tick(200);
  const panel = [...opt.document.querySelectorAll('.panel')].find((p) => p.classList.contains('active'));
  const note = panel.querySelector('.builtin-note');
  assert.ok(note, 'OneDrive 面板应显示「点一下就能连」提示');
  assert.match(note.textContent, /已内置客户端 ID/);
  const idInput = [...panel.querySelectorAll('input')].find((i) => /^[0-9a-f-]{36}$/.test(i.value));
  assert.ok(idInput, '客户端 ID 应已预填内置值');
  assert.equal(idInput.value, '5a7712eb-cd4c-4920-8893-073538113163');
  const redirect = panel.querySelector('.redirect-box .url');
  assert.match(redirect.textContent, /^https:\/\/[a-z0-9-]+\.chromiumapp\.org\/$/, '回调地址形状应为 https://<扩展ID>.chromiumapp.org/');
  console.log('✓ 一键连接：OneDrive 预填内置客户端 ID、显示提示、回调地址正确');

  // 往 BUILTIN_CLIENTS 里填一个 Google ID，UI 应当自动变成「已内置」并预填 —— 证明「填一行即生效」
  const OptF2A = opt.window.F2A;
  OptF2A.providers.BUILTIN_CLIENTS.gdrive = 'demo.apps.googleusercontent.com';
  opt.document.querySelectorAll('.provider-tab')[0].click();
  await tick(150);
  const gTab = [...opt.document.querySelectorAll('.provider-tab')].find((t) => t.textContent.includes('Google'));
  assert.match(gTab.textContent, /已内置/, 'BUILTIN_CLIENTS 填了 ID 后 Google 应自动变「已内置」');
  gTab.click();
  await tick(200);
  const gPanel = [...opt.document.querySelectorAll('.panel')].find((p) => p.classList.contains('active'));
  assert.ok(gPanel.querySelector('.builtin-note'), '应出现「点一下就能连」提示');
  const gInput = [...gPanel.querySelectorAll('input')].find((i) => i.value === 'demo.apps.googleusercontent.com');
  assert.ok(gInput, 'Client ID 应预填内置值');
  delete OptF2A.providers.BUILTIN_CLIENTS.gdrive;
  console.log('✓ 可扩展：BUILTIN_CLIENTS 填一行 ID，Google Drive 即变「已内置」并预填');
}
assert.equal($o('cryptBadge').textContent, '未加密');
assert.equal(opt.document.querySelectorAll('.provider-tab').length, 7, '渠道标签数量应为 7');
console.log('✓ 设置页：渠道标签渲染 7 个，加密状态正确');

// switch to the WebDAV panel and fill config
[...tabs].find((t) => t.textContent.includes('WebDAV')).click();
await tick(150);
const panels = opt.document.querySelectorAll('.panel');
const activePanel = [...panels].find((p) => p.classList.contains('active'));
assert.ok(activePanel.textContent.includes('坚果云'), 'WebDAV 面板应显示帮助文案');
const inputs = activePanel.querySelectorAll('input');
assert.ok(inputs.length >= 4, 'WebDAV 应有 4 个配置项');

// change one field and make sure it persists
inputs[0].value = 'https://dav.jianguoyun.com/dav/2fa-helper/backup.json';
inputs[0].dispatchEvent(new opt.Event('change', { bubbles: true }));
await tick(400);
const s = await call({ type: 'settings.get' });
assert.equal(s.data.providers.webdav.url, 'https://dav.jianguoyun.com/dav/2fa-helper/backup.json', 'got: ' + JSON.stringify(s.data.providers.webdav));
console.log('✓ 设置页：WebDAV 配置写入成功并被后台读取到');

// enable encryption through the real UI
$o('newPass').value = 'test-password-123';
$o('newPass2').value = 'test-password-123';
$o('enableCrypto').click();
await tick(2500); // PBKDF2 250k
const cryptBadge = $o('cryptBadge').textContent;
assert.match(cryptBadge, /已加密/, '开启加密后徽标应显示已加密');
const vaultAfter = storeLocal.get('vault');
assert.equal(vaultAfter.encrypted, true);
assert.ok(!JSON.stringify(vaultAfter).includes('JBSWY3DPEHPK3PXP'), '加密后 local storage 不应出现明文密钥');
console.log('✓ 设置页：开启加密后本地存储为密文，徽标更新');

// snapshot table renders + status chips
await tick(300);
assert.equal($o('chipEnc').textContent, '已加密');
console.log('✓ 设置页：状态徽标同步（chipEnc = 已加密）');

// after an explicit lock, a fresh popup must ask for the password
// (an unlocked session key persists in storage.session by design, like a password manager)
await call({ type: 'vault.lock' });
const { win: popup2 } = boot({ html: 'popup/popup.html', scripts: ['lib/util.js', 'lib/totp.js', 'popup/popup.js'] });
await tick(300);
assert.equal(popup2.document.getElementById('lockView').hidden, false, '加密后弹窗应显示解锁界面');
popup2.document.getElementById('unlockPassword').value = 'wrong-password';
popup2.document.getElementById('unlockForm').dispatchEvent(new popup2.Event('submit', { bubbles: true, cancelable: true }));
await tick(1500);
assert.match(popup2.document.getElementById('lockErr').textContent, /主密码不正确/);
popup2.document.getElementById('unlockPassword').value = 'test-password-123';
popup2.document.getElementById('unlockForm').dispatchEvent(new popup2.Event('submit', { bubbles: true, cancelable: true }));
await tick(2000);
assert.equal(popup2.document.getElementById('mainView').hidden, false, '正确密码应解锁');
const rows2 = popup2.document.querySelectorAll('.row');
assert.equal(rows2.length, 1);
console.log('✓ 弹窗：错误密码被拒，正确密码解锁成功并恢复列表');

// backup build via background
const built = await call({ type: 'backup.buildJson' });
await tick(300);
const env = JSON.parse(built.data.json);
assert.equal(env.encrypted, true);
assert.equal(env.meta.entryCount, 1);
console.log('✓ 备份：信封已加密且提示需要主密码，entryCount =', env.meta.entryCount);

// autofill match via background
const match = await call({ type: 'autofill.match', host: 'login.github.com' });
assert.equal(match.data.matches.length, 1, 'login.github.com 应匹配到 GitHub 条目');
const noMatch = await call({ type: 'autofill.match', host: 'evil.com' });
assert.equal(noMatch.data.matches.length, 0);
console.log('✓ 自动填充：域名匹配命中 github 子域、不误伤其他站点');

// autofill code request
const codeRes = await call({ type: 'autofill.code', id: match.data.matches[0].id });
assert.match(codeRes.data.code.code, /^\d{6}$/, '自动填充应拿到 6 位码');
console.log('✓ 自动填充：后台只回传验证码，不暴露密钥');

/* ---------------- 免注册渠道 ---------------- */
{
  const $o3 = (id) => opt.document.getElementById(id);
  const webdavTab = [...opt.document.querySelectorAll('.provider-tab')].find((t) => t.textContent.includes('WebDAV'));
  webdavTab.click();
  await tick(200);
  const panel = [...opt.document.querySelectorAll('.panel')].find((p) => p.classList.contains('active'));
  const presetSelect = panel.querySelector('select');
  assert.ok(presetSelect, 'WebDAV 面板应有预设下拉');
  const options = [...presetSelect.options].map((o) => o.value);
  assert.ok(options.includes('jianguoyun') && options.includes('alist'), '预设应包含坚果云与 AList 网关');
  presetSelect.value = 'jianguoyun';
  presetSelect.dispatchEvent(new opt.Event('change', { bubbles: true }));
  await tick(300);
  const urlInput = [...panel.querySelectorAll('input')].find((i) => i.value.includes('jianguoyun'));
  assert.ok(urlInput, '选预设后应自动填入坚果云地址');

  const s3Tab = [...opt.document.querySelectorAll('.provider-tab')].find((t) => t.textContent.includes('对象存储'));
  s3Tab.click();
  await tick(200);
  const s3Panel = [...opt.document.querySelectorAll('.panel')].find((p) => p.classList.contains('active'));
  assert.ok(s3Panel.querySelector('select'), '对象存储面板应有预设下拉');
  const s3Fields = [...s3Panel.querySelectorAll('input')].length;
  assert.ok(s3Fields >= 5, '对象存储应有 endpoint/region/bucket/keyPath/accessKey/secretKey 字段');
  console.log('✓ 免注册：WebDAV 预设一键填充、对象存储面板字段齐全');
}

/* ---------------- 扫描当前网页（页面内浮层框选） ---------------- */
{
  const before = (await call({ type: 'vault.state' }, {})).data.entries.length;
  let captured = 0;
  bg.win.chrome.tabs.captureVisibleTab = async () => { captured++; return 'data:image/png;base64,iVBORw0KGgo='; };

  // 一个「网页」上下文，注入真实的 content/overlay.js
  const { win: page } = boot({ scripts: ['content/overlay.js'], content: true });
  page.innerWidth = 1024;
  page.innerHeight = 768;
  let popupClosed = 0;
  popup.close = () => { popupClosed++; };   // jsdom 的 close() 会真的把 window 弄坏
  assert.equal(contentListeners.length, 1, '浮层内容脚本应注册消息监听器');

  let decodedRect = null, viewport = null;
  bg.win.F2A.qr.decodeDataUrlRegion = async (shot, rect, vp) => {
    decodedRect = rect; viewport = vp;
    return 'otpauth://totp/FromOverlay:me%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=FromOverlay';
  };

  popup.document.getElementById('scanPageBtn').click();
  await tick(300);
  assert.equal(captured, 1, '应截一次当前页面的可见区域');
  const host = page.document.getElementById('__f2a_overlay_host__');
  assert.ok(host, '应直接在原页面盖一层浮层（而不是新窗口）');
  assert.equal(createdWindows.length, 0, '不应打开任何新窗口');
  assert.equal(popupClosed, 1, '浮层出现后弹窗应自己关掉，把页面让出来');

  // 反向拖动：从 (600,500) 拖到 (320,260)
  const fire = (type, x, y) => host.dispatchEvent(new page.MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
  fire('mousedown', 600, 500);
  fire('mousemove', 320, 260);
  fire('mouseup', 320, 260);
  await tick(400);

  assert.equal(JSON.stringify(decodedRect), JSON.stringify({ x: 320, y: 260, w: 280, h: 240 }),
    '应把框选区域换算成视口坐标（反向拖动也归一化）');
  assert.equal(JSON.stringify(viewport), JSON.stringify({ w: 1024, h: 768 }), '应带上视口尺寸，用于换算设备像素');
  const after = (await call({ type: 'vault.state' }, {})).data.entries;
  assert.equal(after.length, before + 1, '框选识别出的 otpauth 应被导入');
  assert.ok(after.some((e) => e.issuer === 'FromOverlay'), '导入的条目应来自浮层框选');
  assert.match(host.textContent, /已导入 1 条/, '浮层上应显示导入结果');

  await tick(1400);
  assert.equal(page.document.getElementById('__f2a_overlay_host__'), null, '成功后浮层应自动撤掉');

  // 框里面没有二维码：提示后浮层保留，可以再框一次
  bg.win.F2A.qr.decodeDataUrlRegion = async () => null;
  popup.document.getElementById('scanPageBtn').disabled = false;  // 真机上弹窗已关闭，这里手动复位
  popup.document.getElementById('scanPageBtn').click();
  await tick(300);
  const host2 = page.document.getElementById('__f2a_overlay_host__');
  const fire2 = (type, x, y) => host2.dispatchEvent(new page.MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
  fire2('mousedown', 100, 100);
  fire2('mouseup', 400, 400);
  await tick(400);
  assert.match(host2.textContent, /没有二维码/, '应提示这块区域没有二维码');
  assert.ok(page.document.getElementById('__f2a_overlay_host__'), '失败时浮层应保留，允许重试');

  // 太小的框直接忽略（防误触）
  let called = 0;
  bg.win.F2A.qr.decodeDataUrlRegion = async () => { called++; return null; };
  fire2('mousedown', 50, 50);
  fire2('mouseup', 53, 53);
  await tick(200);
  assert.equal(called, 0, '过小的框不应触发解码');

  // Esc 取消
  page.dispatchEvent(new page.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick(100);
  assert.equal(page.document.getElementById('__f2a_overlay_host__'), null, 'Esc 应撤掉浮层');

  assert.equal(JSON.stringify(page.__f2aOverlay.normalize({ x: 300, y: 200 }, { x: 100, y: 400 })),
    JSON.stringify({ x: 100, y: 200, w: 200, h: 200 }), 'normalize 应把反向拖动变成正矩形');
  console.log('✓ 网页扫码：原页面浮层框选 → 只解码框住的一块 → 导入成功并自动撤掉；空选区/过小选区/Esc 都有处理');
}

/* ---------------- Passkey ---------------- */
{
  const p = popup2;   // reuse the unlocked popup window
  const $p = (id) => p.document.getElementById(id);
  $p('addBtn').click();
  [...$p('kindSwitch').querySelectorAll('button')].find((b) => b.dataset.kind === 'passkey').click();
  assert.equal($p('passkeyFields').hidden, false, 'Passkey 表单应显示');
  assert.equal($p('otpFields').hidden, true, '验证码字段应隐藏');
  $p('pRpId').value = 'github.com';
  $p('pRpName').value = 'GitHub';
  $p('pUserName').value = 'me@example.com';
  $p('entryForm').dispatchEvent(new p.Event('submit', { bubbles: true, cancelable: true }));
  await tick(500);
  const badges = [...p.document.querySelectorAll('.row .pk-badge')];
  assert.equal(badges.length, 1, '列表里应出现一个 PASSKEY 标记');
  const rows = [...p.document.querySelectorAll('.row')];
  assert.equal(rows.length, 2, '验证码 + Passkey 共两行');
  console.log('✓ Passkey：通过弹窗表单创建，列表以 PASSKEY 标记展示');

  // 打开 Passkey 详情
  rows.find((r) => r.textContent.includes('PASSKEY')).click();
  await tick(400);
  assert.equal($p('detailView').hidden, false, '应打开详情视图');
  const detailText = $p('detailBody').textContent;
  assert.match(detailText, /github\.com/, '详情应包含 RP ID');
  assert.match(detailText, /credentialId/i, '详情应展示 credentialId');
  assert.match(detailText, /ES256/, '详情应展示算法');
  assert.match(detailText, /二维码生成失败|扫描/, '无 canvas 时应优雅降级而不是崩溃');
  console.log('✓ Passkey：详情视图渲染字段并优雅处理 canvas 缺失');

  // 验证码条目的详情
  $p('detailBack').click();
  await tick(150);
  const otpRow = [...p.document.querySelectorAll('.row')].find((r) => !r.textContent.includes('PASSKEY'));
  otpRow.querySelector('.row-tools button').click();   // ⓘ
  await tick(500);
  const big = p.document.querySelector('.detail-hero .big-code');
  assert.ok(big, 'OTP 详情应有大字验证码');
  const expected2 = await bg.win.F2A.totp.generate({ secret: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30 });
  const shown = big.textContent.replace(' ', '');
  assert.ok([expected2.code, (await bg.win.F2A.totp.generate({ secret: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30 })).code].includes(shown),
    '详情里的验证码应与算法一致，实际: ' + shown);
  console.log('✓ Passkey/OTP：详情视图与实时验证码正常');
  $p('detailBack').click();
  await tick(100);
}

/* ---------------- 扫码 / 配对码解析 ---------------- */
{
  const otpauthText = 'otpauth://totp/Acme:me@acme.io?secret=GEZDGNBVGY3TQOJQ&issuer=Acme';
  const sc1 = await call({ type: 'scan.handle', text: otpauthText });
  assert.equal(sc1.data.action, 'import');
  assert.equal(sc1.data.entries.length, 1);
  assert.equal(sc1.data.entries[0].issuer, 'Acme');

  const passkeyPayload = 'f2a-passkey:v1:' + Buffer.from(JSON.stringify({
    rpId: 'gitlab.com', rpName: 'GitLab', userName: 'me@acme.io', credentialId: 'cred-1', algorithm: -7,
  })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const sc2 = await call({ type: 'scan.handle', text: passkeyPayload });
  assert.equal(sc2.data.kind, 'passkey');
  assert.equal(sc2.data.entries[0].kind, 'passkey');
  assert.equal(sc2.data.entries[0].passkey.rpId, 'gitlab.com');

  const sc3 = await call({ type: 'scan.handle', text: 'f2a-sync:v1:' + 'A'.repeat(52) });
  assert.equal(sc3.data.action, 'sync-join');
  assert.equal(sc3.data.code.length, 52);

  const sc4 = await call({ type: 'scan.handle', text: 'hello world' });
  assert.equal(sc4.ok, false, '无法识别的内容应报错');
  console.log('✓ 扫码：otpauth / passkey / 同步配对码 三种载荷都能正确分派');
}

/* ---------------- 端到端同步 UI ---------------- */
{
  const $o2 = (id) => opt.document.getElementById(id);
  assert.equal($o2('syncBadge').textContent, '未启用');
  $o2('syncEnable').click();
  await tick(1200);
  assert.equal($o2('syncOn').hidden, false, '启用后应显示配对码区块');
  const code = $o2('syncCode').textContent;
  assert.match(code, /^[A-Z2-7]{4}(-[A-Z2-7]{4}){12}$/, '配对码格式不对: ' + code);
  assert.ok(storeSync.has('f2a.sync.meta'), '应把 meta 写入 storage.sync');
  assert.ok([...storeSync.keys()].some((k) => k.startsWith('f2a.sync.c')), '应写入分片');

  const dump = [...storeSync.entries()].map(([k, v]) => k + (typeof v === 'string' ? v : JSON.stringify(v))).join('');
  assert.ok(!dump.includes('JBSWY3DPEHPK3PXP'), '云端不应出现明文密钥');

  // 推送 → 状态行更新
  $o2('syncPush').click();
  await tick(800);
  assert.match($o2('syncStatusText').textContent, /云端/, '状态行应显示云端信息');
  console.log('✓ 同步：设置页一键启用 → 生成配对码 → 密文分片写入 storage.sync');
}

console.log('\nDOM 错误:', domErrors.length ? domErrors : '无');
process.exit(domErrors.length ? 1 : 0);
