/**
 * storage.sync 端到端同步测试：
 *  - 用带真实配额限制的假 storage.sync（单项 8 KB / 总量 100 KB / 512 项）
 *  - 两个"设备"共享同一份 cloud，验证配对、推送、拉取、篡改检测、冲突判断
 *   node test/sync.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const LIBS = ['util.js', 'totp.js', 'crypto.js', 'vault.js', 'providers.js', 'backup.js', 'sync.js'];
const SRC = LIBS.map((f) => readFileSync(path.join(ROOT, 'src/lib', f), 'utf8'));

const QUOTA_BYTES = 102400;
const QUOTA_BYTES_PER_ITEM = 8192;
const MAX_ITEMS = 512;

function plainArea(map) {
  return {
    _map: map,
    async get(keys) {
      if (keys === null || keys === undefined) return Object.fromEntries([...map].map(([k, v]) => [k, structuredClone(v)]));
      const out = {};
      for (const k of typeof keys === 'string' ? [keys] : keys) if (map.has(k)) out[k] = structuredClone(map.get(k));
      return out;
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) map.set(k, structuredClone(v)); },
    async remove(keys) { for (const k of [].concat(keys)) map.delete(k); },
    async clear() { map.clear(); },
    async getBytesInUse() { return [...map.values()].reduce((n, v) => n + JSON.stringify(v).length, 0); },
  };
}

/** Enforces the same limits Chrome puts on storage.sync. */
function quotaArea(map) {
  const base = plainArea(map);
  return {
    ...base,
    async set(obj) {
      const next = new Map(map);
      for (const [k, v] of Object.entries(obj)) {
        const size = Buffer.byteLength(k) + Buffer.byteLength(JSON.stringify(v));
        if (size > QUOTA_BYTES_PER_ITEM) {
          const e = new Error(`QUOTA_BYTES_PER_ITEM quota exceeded (${size} > ${QUOTA_BYTES_PER_ITEM})`);
          e.code = 'QUOTA_BYTES_PER_ITEM';
          throw e;
        }
        next.set(k, v);
      }
      const total = [...next.entries()].reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(JSON.stringify(v)), 0);
      if (total > QUOTA_BYTES) {
        const e = new Error(`QUOTA_BYTES quota exceeded (${total} > ${QUOTA_BYTES})`);
        e.code = 'QUOTA_BYTES';
        throw e;
      }
      if (next.size > MAX_ITEMS) throw new Error('MAX_ITEMS quota exceeded');
      for (const [k, v] of Object.entries(obj)) map.set(k, v);
    },
  };
}

function makeDevice(cloud, label) {
  const local = new Map();
  const session = new Map();
  const ctx = vm.createContext({
    console, crypto: webcrypto, TextEncoder, TextDecoder, Blob, URL,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    setTimeout, clearTimeout, BigInt, fetch: () => { throw new Error('no network in tests'); },
    chrome: {
      runtime: { id: 'dev-' + label, getManifest: () => ({ version: '1.0.0' }), onMessage: { addListener() {} } },
      storage: { local: plainArea(local), session: plainArea(session), sync: quotaArea(cloud), onChanged: { addListener() {} } },
      alarms: { onAlarm: { addListener() {} }, async getAll() { return []; }, async clear() {}, create() {}, async get() { return null; } },
      action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
      identity: { getRedirectURL: () => 'https://dev.chromiumapp.org/' },
      permissions: { async contains() { return true; }, async request() { return true; } },
      downloads: { async download() { return 1; } },
    },
  });
  for (const code of SRC) vm.runInContext(code, ctx);
  return { F2A: ctx.F2A, local, session, ctx };
}

let passed = 0;
const fails = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { fails.push(name); console.log('  ✗ ' + name + '\n      ' + e.message); }
}

const cloud = new Map();
const A = makeDevice(cloud, 'A');
const B = makeDevice(cloud, 'B');

console.log('\n端到端加密同步');

await test('启用同步：生成 52 位配对码，并把密文分片写入 storage.sync', async () => {
  await A.F2A.vault.unlock('');
  await A.F2A.vault.upsertEntry({ issuer: 'GitHub', account: 'me@x.com', secret: 'JBSWY3DPEHPK3PXP' });
  await A.F2A.vault.upsertEntry({ issuer: 'Cloudflare', account: 'me@x.com', secret: 'GEZDGNBVGY3TQOJQ' });
  const res = await A.F2A.sync.enable();
  assert.equal(res.code.replace(/-/g, '').length, 52, '配对码应为 52 位 Base32');
  assert.match(res.code, /^[A-Z2-7]{4}(-[A-Z2-7]{4}){12}$/);
  const keys = [...cloud.keys()];
  assert.ok(keys.includes('f2a.sync.meta'), '应写入 meta');
  assert.ok(keys.some((k) => k.startsWith('f2a.sync.c')), '应写入分片');
  const meta = cloud.get('f2a.sync.meta');
  assert.equal(meta.chunks, keys.filter((k) => k.startsWith('f2a.sync.c')).length);
  assert.equal(meta.entryCount, 2);
});

await test('云端只有密文：不出现站点名、账户或密钥', async () => {
  const dump = [...cloud.entries()].map(([k, v]) => k + '|' + (typeof v === 'string' ? v : JSON.stringify(v))).join('\n');
  const leaks = ['JBSWY3DPEHPK3PXP', 'GEZDGNBVGY3TQOJQ', 'me@x.com', 'Cloudflare', 'GitHub'].filter((s) => dump.includes(s));
  assert.equal(leaks.length, 0, '云端不应出现明文: ' + leaks.join(','));
  const record = JSON.parse(cloud.get('f2a.sync.c0'));
  assert.equal(record.alg, 'A256GCM');
  assert.ok(record.iv && record.ct && record.sha, '记录应含 iv/ct/sha');
  const meta = cloud.get('f2a.sync.meta');
  assert.ok(!('ct' in meta), 'meta 只放组装信息，不放密文');
});

await test('每片都小于 storage.sync 的单项配额', async () => {
  for (const [k, v] of cloud) {
    const size = Buffer.byteLength(k) + Buffer.byteLength(JSON.stringify(v));
    assert.ok(size <= QUOTA_BYTES_PER_ITEM, `${k} 超出单项配额: ${size}`);
  }
});

await test('设备 B 用配对码加入并拉取（含主密码加密的保管库）', async () => {
  await A.F2A.vault.setMasterPassword('master-pass-1');
  await A.F2A.sync.push();

  const code = A.F2A.sync.formatCode(await A.F2A.sync.getKey());
  await B.F2A.vault.unlock('');                       // B 本地是空的、未加密
  const joined = await B.F2A.sync.join(code);
  assert.equal(joined.hasRemote, true);
  assert.equal(joined.remoteEntryCount, 2);

  const first = await B.F2A.sync.pull();
  assert.equal(first.needsPassword, true, '加密保管库应要求主密码');

  await assert.rejects(() => B.F2A.sync.pull('wrong'), /主密码不正确/);
  const done = await B.F2A.sync.pull('master-pass-1');
  assert.equal(done.ok, true);
  assert.equal(done.entries, 2);

  const st = await B.F2A.vault.state();
  assert.equal(st.locked, false, '拉取后应保持解锁');
  const issuers = Array.from(st.data.entries.map((e) => e.issuer)).sort().join(',');
  assert.equal(issuers, 'Cloudflare,GitHub');
});

await test('配对码错误：加入失败并回滚，不会留下半启用状态', async () => {
  const C = makeDevice(cloud, 'C');
  await C.F2A.vault.unlock('');
  await assert.rejects(() => C.F2A.sync.join('A'.repeat(52)), /配对失败/);
  const check = await C.F2A.sync.check();
  assert.equal(check.enabled, false, '失败后应自动关闭同步');
  assert.equal(check.hasKey, false, '失败后不应保留错误配对码');
});

await test('云端分片被篡改会被校验/认证拦下', async () => {
  const B2 = makeDevice(cloud, 'B2');
  await B2.F2A.vault.unlock('');
  await B2.F2A.sync.join(A.F2A.sync.formatCode(await A.F2A.sync.getKey()));
  const chunkKey = [...cloud.keys()].find((k) => k.startsWith('f2a.sync.c'));
  const original = cloud.get(chunkKey);
  cloud.set(chunkKey, original.slice(0, -4) + 'AAAA');
  await assert.rejects(() => B2.F2A.sync.pull('master-pass-1'), /校验失败|解密失败|分片/);
  cloud.set(chunkKey, original);
  const ok = await B2.F2A.sync.pull('master-pass-1');
  assert.equal(ok.ok, true, '还原分片后应可正常拉取');
});

await test('云端比本机新时 remoteIsNewer 为真，拉取后归位', async () => {
  await new Promise((r) => setTimeout(r, 700)); // 让两条记录的时间戳拉开
  await A.F2A.vault.upsertEntry({ issuer: 'Newest', account: 'x', secret: 'GEZDGNBVGY3TQOJQ' });
  await A.F2A.sync.push();
  const check = await B.F2A.sync.check();
  assert.equal(check.remoteIsNewer, true);
  assert.equal(check.remoteEntryCount, 3);
  await B.F2A.sync.pull('master-pass-1');
  const after = await B.F2A.sync.check();
  assert.equal(after.remoteIsNewer, false, '应用过之后不应再提示更新');
});

await test('多分片：条目变多时自动切分并清理旧分片', async () => {
  for (let i = 0; i < 40; i++) {
    await A.F2A.vault.upsertEntry({
      issuer: 'Service-' + i,
      account: `user${i}@example.com`,
      secret: 'JBSWY3DPEHPK3PXP',
      note: 'x'.repeat(120),
    });
  }
  const res = await A.F2A.sync.push();
  assert.ok(res.chunks >= 2, '应切分为多片，实际 ' + res.chunks);
  const chunkKeys = [...cloud.keys()].filter((k) => k.startsWith('f2a.sync.c'));
  assert.equal(chunkKeys.length, res.chunks, '不应残留多余分片');
  for (const [k, v] of cloud) {
    assert.ok(Buffer.byteLength(k) + Buffer.byteLength(JSON.stringify(v)) <= QUOTA_BYTES_PER_ITEM);
  }
  const check = await A.F2A.sync.check();
  assert.equal(check.remoteEntryCount, 43);
});

await test('超出同步配额时给出清晰错误而不是静默失败', async () => {
  const before = new Map(cloud);
  for (let i = 0; i < 400; i++) {
    await A.F2A.vault.upsertEntry({ issuer: 'Bulk-' + i, account: 'u@x.com', secret: 'JBSWY3DPEHPK3PXP', note: 'y'.repeat(200) });
  }
  await assert.rejects(() => A.F2A.sync.push(), /超出 storage\.sync|过大/);
  // 清理掉这批超大条目，恢复成可同步的体积
  const st = await A.F2A.vault.requireData();
  for (const e of st.data.entries.filter((x) => x.issuer.startsWith('Bulk-'))) {
    await A.F2A.vault.deleteEntry(e.id);
  }
  cloud.clear();
  for (const [k, v] of before) cloud.set(k, v);
});

await test('内容未变化时不重复推送（避免两台设备来回互推）', async () => {
  await A.F2A.sync.push({ force: true });
  const before = cloud.get('f2a.sync.meta').pushedAt;
  const res = await A.F2A.sync.push();
  assert.equal(res.skipped, true, '内容一致应跳过');
  assert.equal(cloud.get('f2a.sync.meta').pushedAt, before, '云端不应被重写');
  const forced = await A.F2A.sync.push({ force: true });
  assert.equal(forced.skipped, undefined, '强制推送应真的写入');
});

await test('拉取后会短暂抑制自动回推', async () => {
  const D = makeDevice(cloud, 'D');
  await D.F2A.vault.unlock('');
  await D.F2A.sync.join(A.F2A.sync.formatCode(await A.F2A.sync.getKey()));
  assert.equal(D.F2A.sync.isSuppressed(), false);
  await D.F2A.sync.pull('master-pass-1');
  assert.equal(D.F2A.sync.isSuppressed(), true, '应用云端版本后应抑制自动推送，防止回声');
});

await test('停止同步会清除云端密文与本机配对码', async () => {
  await A.F2A.sync.disable({ wipeRemote: true });
  assert.equal([...cloud.keys()].filter((k) => k.startsWith('f2a.sync.')).length, 0);
  assert.equal(await A.F2A.sync.getKey(), '');
  const check = await A.F2A.sync.check();
  assert.equal(check.enabled, false);
  assert.equal(check.hasRemote, false);
});

await test('不支持 storage.sync 的环境给出可读提示', async () => {
  const noSync = makeDevice(new Map(), 'D');
  delete noSync.ctx.chrome.storage.sync;
  const F2A = noSync.F2A;
  F2A.api.storage.sync = undefined;
  assert.equal(F2A.sync.available(), false);
  await assert.rejects(() => F2A.sync.enable(), /不支持 storage\.sync/);
});

console.log(`\n${fails.length ? '✗' : '✓'} ${passed} passed, ${fails.length} failed\n`);
if (fails.length) process.exit(1);
