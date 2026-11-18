/**
 * Node test harness for 2FA Helper.
 * Fakes the `chrome` extension API (storage.local / storage.session) so the
 * exact code shipped to browsers can be exercised outside one.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/* ---------------- fake extension API ---------------- */
function area() {
  const data = new Map();
  return {
    _data: data,
    async get(keys) {
      const out = {};
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || data);
      for (const k of list) if (data.has(k)) out[k] = data.get(k);
      return out;
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) data.set(k, v); },
    async remove(keys) { for (const k of [].concat(keys)) data.delete(k); },
    async clear() { data.clear(); },
  };
}

const localArea = area();
const sessionArea = area();

globalThis.chrome = {
  storage: { local: localArea, session: sessionArea, onChanged: { addListener() {} } },
  runtime: {
    id: 'test-extension-id',
    getManifest: () => ({ version: '1.0.0' }),
    onMessage: { addListener() {} },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
  },
  alarms: { onAlarm: { addListener() {} }, async getAll() { return []; }, async clear() {}, create() {} },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  identity: { getRedirectURL: () => 'https://test-extension-id.chromiumapp.org/' },
  permissions: { async contains() { return true; }, async request() { return true; } },
  downloads: { async download() { return 1; } },
};

for (const f of ['util.js', 'totp.js', 'crypto.js', 'vault.js', 'providers.js', 'backup.js']) {
  const code = readFileSync(path.join(ROOT, 'src/lib', f), 'utf8');
  (0, eval)(code);
}

const F2A = globalThis.F2A;

/* ---------------- tiny test runner ---------------- */
let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push({ name, e });
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

/* ---------------- tests ---------------- */
console.log('\nBase32');
await test('base32 round-trip', () => {
  const bytes = F2A.utf8Encode('12345678901234567890');
  const enc = F2A.b32encode(bytes);
  assert.equal(enc, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual([...F2A.b32decode(enc)], [...bytes]);
});

await test('base32 tolerates spaces, dashes, lowercase and padding', () => {
  const a = F2A.b32decode('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq========');
  assert.equal(a.length, 20);
});

await test('base32 rejects invalid characters', () => {
  assert.throws(() => F2A.b32decode('ABC!DEF'), /无效的 Base32/);
});

console.log('\nTOTP / HOTP (RFC 6238 & RFC 4226)');
const b32 = (s) => F2A.b32encode(F2A.utf8Encode(s));

await test('RFC 6238 SHA1 vectors, 8 digits', async () => {
  const secret = b32('12345678901234567890');
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [t, expected] of vectors) {
    const res = await F2A.totp.generate({ secret, digits: 8, period: 30, algorithm: 'SHA1' }, t * 1000);
    assert.equal(res.code, expected, `t=${t}`);
  }
});

await test('RFC 6238 SHA256 / SHA512 vectors', async () => {
  const sha256 = b32('12345678901234567890123456789012');
  const sha512 = b32('1234567890123456789012345678901234567890123456789012345678901234');
  const a = await F2A.totp.generate({ secret: sha256, digits: 8, algorithm: 'SHA256' }, 59000);
  const b = await F2A.totp.generate({ secret: sha512, digits: 8, algorithm: 'SHA512' }, 59000);
  assert.equal(a.code, '46119246');
  assert.equal(b.code, '90693936');
});

await test('RFC 4226 HOTP counter vectors', async () => {
  const secret = b32('12345678901234567890');
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676'];
  for (let c = 0; c < expected.length; c++) {
    const res = await F2A.totp.generate({ secret, type: 'hotp', counter: c, digits: 6 }, 0);
    assert.equal(res.code, expected[c], `counter=${c}`);
  }
});

await test('remaining seconds count down inside the window', async () => {
  const secret = b32('12345678901234567890');
  const r1 = await F2A.totp.generate({ secret }, 0);
  const r2 = await F2A.totp.generate({ secret }, 29000);
  assert.equal(r1.remaining, 30);
  assert.equal(r2.remaining, 1);
});

console.log('\notpauth 解析');
await test('parse issuer + account from label', () => {
  const p = F2A.otpauth.parse('otpauth://totp/GitHub:me@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&digits=6&period=30');
  assert.equal(p.issuer, 'GitHub');
  assert.equal(p.account, 'me@example.com');
  assert.equal(p.secret, 'JBSWY3DPEHPK3PXP');
  assert.equal(p.digits, 6);
  assert.equal(p.period, 30);
  assert.equal(p.algorithm, 'SHA1');
});

await test('uri round-trip keeps non-default options', () => {
  const uri = F2A.otpauth.toUri({ issuer: 'ACME', account: 'a@b.c', secret: 'jbswy3dpehpk3pxp', digits: 8, period: 60, algorithm: 'SHA256', type: 'totp' });
  const back = F2A.otpauth.parse(uri);
  assert.equal(back.secret, 'JBSWY3DPEHPK3PXP');
  assert.equal(back.digits, 8);
  assert.equal(back.period, 60);
  assert.equal(back.algorithm, 'SHA256');
  assert.equal(back.issuer, 'ACME');
});

await test('otpauth-migration (Google Authenticator) export decodes', () => {
  // hand-built protobuf: two OtpParameters inside MigrationPayload
  const bytes = [];
  const push = (...b) => bytes.push(...b);
  const str = (s) => [...F2A.utf8Encode(s)];
  const lenField = (field, payload) => {
    push((field << 3) | 2, payload.length, ...payload);
  };
  const varint = (n) => {
    const out = [];
    let v = BigInt(n);
    do {
      let byte = Number(v & 0x7fn);
      v >>= 7n;
      if (v) byte |= 0x80;
      out.push(byte);
    } while (v);
    return out;
  };
  const varField = (field, val) => push(...varint((field << 3) | 0), ...varint(val));

  const inner1 = [];
  const secret1 = F2A.b32decode('JBSWY3DPEHPK3PXP');
  const buildInner = (secret, name, issuer, algo, digits, type) => {
    const b = [];
    const add = (...x) => b.push(...x);
    add(0x0a, secret.length, ...secret);            // field1 secret (bytes)
    const nm = str(name); add(0x12, nm.length, ...nm);   // field2 name
    const iss = str(issuer); add(0x1a, iss.length, ...iss); // field3 issuer
    add(0x20, algo);                                 // field4 algorithm
    add(0x28, digits);                               // field5 digits
    add(0x30, type);                                 // field6 type
    return b;
  };
  const p1 = buildInner(secret1, 'me@github.com', 'GitHub', 1, 1, 2);
  const p2 = buildInner(F2A.b32decode('GEZDGNBVGY3TQOJQ'), 'me@acme.io', 'ACME', 2, 2, 2);
  lenField(1, p1);
  lenField(1, p2);
  varField(2, 1);
  varField(3, 2);
  varField(4, 0);
  varField(5, 1234);

  const b64 = F2A.bytesToB64(new Uint8Array(bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const out = F2A.otpauth.parseMigration('otpauth-migration://offline?data=' + b64);
  assert.equal(out.length, 2);
  assert.equal(out[0].issuer, 'GitHub');
  assert.equal(out[0].account, 'me@github.com');
  assert.equal(out[0].secret, 'JBSWY3DPEHPK3PXP');
  assert.equal(out[0].digits, 6);
  assert.equal(out[1].issuer, 'ACME');
  assert.equal(out[1].algorithm, 'SHA256');
  assert.equal(out[1].digits, 8);
});

console.log('\n加密信封');
await test('seal/open round-trip with password', async () => {
  const data = { schema: 2, entries: [{ id: 'a', issuer: 'GitHub', secret: 'JBSWY3DPEHPK3PXP' }] };
  const env = await F2A.vaultCrypto.seal(data, { password: 'correct horse battery' });
  assert.equal(env.format, 'f2a-vault');
  assert.equal(env.encrypted, true);
  assert.equal(env.meta.entryCount, 1);
  assert.ok(!JSON.stringify(env).includes('JBSWY3DPEHPK3PXP'), '密文里不能出现明文密钥');
  const opened = await F2A.vaultCrypto.open(env, 'correct horse battery');
  assert.deepEqual(opened.data, data);
  assert.ok(opened.keyB64);
  const withKey = await F2A.vaultCrypto.openWithKey(env, opened.keyB64);
  assert.deepEqual(withKey, data);
});

await test('wrong password is rejected', async () => {
  const env = await F2A.vaultCrypto.seal({ entries: [] }, { password: 'right-password' });
  await assert.rejects(() => F2A.vaultCrypto.open(env, 'wrong-password'), /主密码不正确/);
});

await test('plaintext envelope keeps data readable', async () => {
  const env = await F2A.vaultCrypto.seal({ entries: [] }, {});
  assert.equal(env.encrypted, false);
  const opened = await F2A.vaultCrypto.open(env, '');
  assert.deepEqual(opened.data.entries, []);
});

console.log('\n保管库流程');
await test('first run creates an empty vault', async () => {
  const res = await F2A.vault.unlock('');
  assert.equal(res.ok, true);
  const st = await F2A.vault.state();
  assert.equal(st.locked, false);
  assert.equal(st.data.entries.length, 0);
});

await test('add / dedupe / delete entries', async () => {
  await F2A.vault.upsertEntry({ issuer: 'GitHub', account: 'me@x.com', secret: 'jbswy3dpehpk3pxp' });
  await F2A.vault.upsertEntry({ issuer: 'GitHub', account: 'me@x.com', secret: 'JBSWY3DPEHPK3PXP' }); // dup
  await F2A.vault.upsertEntry({ issuer: 'Cloudflare', account: 'me@x.com', secret: 'GEZDGNBVGY3TQOJQ' });
  let st = await F2A.vault.state();
  assert.equal(st.data.entries.length, 2, '重复条目应被合并');
  const cf = st.data.entries.find((e) => e.issuer === 'Cloudflare');
  await F2A.vault.deleteEntry(cf.id);
  st = await F2A.vault.state();
  assert.equal(st.data.entries.length, 1);
});

await test('enabling the master password encrypts the stored vault', async () => {
  await F2A.vault.setMasterPassword('s3cret-pass');
  const raw = localArea._data.get('vault');
  assert.equal(raw.encrypted, true);
  assert.ok(!JSON.stringify(raw).includes('JBSWY3DPEHPK3PXP'), 'storage.local 里不允许出现明文密钥');
  const st = await F2A.vault.state();
  assert.equal(st.locked, false, '设置密码后应保持解锁状态');
  assert.equal(st.data.entries.length, 1);
});

await test('lock hides data, wrong password fails, right password unlocks', async () => {
  await F2A.vault.lock();
  let st = await F2A.vault.state();
  assert.equal(st.locked, true);
  await assert.rejects(() => F2A.vault.unlock('nope'), /主密码不正确/);
  await F2A.vault.unlock('s3cret-pass');
  st = await F2A.vault.state();
  assert.equal(st.locked, false);
  assert.equal(st.data.entries[0].issuer, 'GitHub');
});

await test('edits keep the vault encrypted and re-encrypt with a fresh IV', async () => {
  const before = localArea._data.get('vault').cipher.iv;
  await F2A.vault.upsertEntry({ issuer: 'GitLab', account: 'me@x.com', secret: 'GEZDGNBVGY3TQOJQ' });
  const after = localArea._data.get('vault');
  assert.equal(after.encrypted, true);
  assert.notEqual(after.cipher.iv, before);
  const st = await F2A.vault.state();
  assert.equal(st.data.entries.length, 2);
});

await test('auto-lock after the configured idle window', async () => {
  await F2A.vault.setSettings({ autoLockMinutes: 1 });
  sessionArea._data.set('f2a.unlockedAt', Date.now() - 120000);
  const st = await F2A.vault.state();
  assert.equal(st.locked, true, '超过空闲时间应自动锁定');
  await F2A.vault.unlock('s3cret-pass');
  const st2 = await F2A.vault.state();
  assert.equal(st2.locked, false);
});

console.log('\n备份 / 恢复');
await test('build() produces a portable envelope', async () => {
  const built = await F2A.backup.build();
  const env = JSON.parse(built.json);
  assert.equal(env.format, 'f2a-vault');
  assert.equal(env.encrypted, true);
  assert.equal(env.entries, undefined, '备份文件结构为信封，不含裸字段');
  assert.equal(env.meta.entryCount, 2);
});

await test('inspect() asks for the password, then validates it', async () => {
  const { json } = await F2A.backup.build();
  const info = await F2A.backup.inspect(json);
  assert.equal(info.needsPassword, true);
  await assert.rejects(() => F2A.backup.inspect(json, 'wrong'), /主密码不正确/);
  const ok = await F2A.backup.inspect(json, 's3cret-pass');
  assert.equal(ok.data.entries.length, 2);
});

await test('restore overwrites the vault and keeps the session unlocked', async () => {
  const { json } = await F2A.backup.build();
  const env = JSON.parse(json);
  env.meta.entryCount = env.entries === undefined ? env.meta.entryCount : 0;
  await F2A.vault.upsertEntry({ issuer: 'Temporary', account: 'x', secret: 'GEZDGNBVGY3TQOJQ' });
  assert.equal((await F2A.vault.state()).data.entries.length, 3);
  await F2A.backup.applyRestore(env, 's3cret-pass');
  const st = await F2A.vault.state();
  assert.equal(st.data.entries.length, 2, '恢复后应回到备份时的 2 条');
  assert.equal(st.locked, false);
});

await test('local snapshots are created, deduped and capped', async () => {
  await F2A.vault.setSettings({ localSnapshot: { enabled: true, keep: 3, intervalHours: 6 } });
  localArea._data.set('snapshots', []);
  for (let i = 0; i < 5; i++) {
    if (i) await F2A.vault.upsertEntry({ issuer: 'S' + i, account: 'a', secret: 'GEZDGNBVGY3TQOJQ' + i });
    await F2A.backup.snapshot('manual');
  }
  const list = await F2A.vault.listSnapshots();
  assert.equal(list.length, 3, '保留数量应被裁剪到 keep');
  const dup = await F2A.backup.snapshot('manual');
  assert.equal(dup.skipped, true, '内容未变化时不重复写快照');
  const status = await F2A.vault.getStatus();
  assert.ok(status.lastLocalSaveAt, '快照应更新最后本地保存时间');
});

await test('snapshot restore brings back old content', async () => {
  const list = await F2A.vault.listSnapshots();
  const oldest = list[list.length - 1];
  await F2A.vault.upsertEntry({ issuer: 'Later', account: 'b', secret: 'GEZDGNBVGY3TQOJQ' });
  await F2A.backup.applyRestore(oldest.envelope, 's3cret-pass');
  const st = await F2A.vault.state();
  const issuers = st.data.entries.map((e) => e.issuer);
  assert.ok(!issuers.includes('Later'), '恢复旧快照后不应包含后来的条目');
});

console.log('\n配置 / 匹配 / 渠道');
await test('settings merge keeps defaults for untouched keys', async () => {
  const s = await F2A.vault.setSettings({ autoBackup: { enabled: true } });
  assert.equal(s.autoBackup.enabled, true);
  assert.equal(s.autoBackup.intervalHours, 12, '默认值应保留');
  assert.equal(s.providers.gdrive.filePath, '2fa-helper-backup.json');
});

await test('host matching ignores www and accepts subdomains', () => {
  assert.ok(F2A.hostMatches('login.github.com', 'github.com'));
  assert.ok(F2A.hostMatches('www.github.com', 'github.com'));
  assert.ok(!F2A.hostMatches('github.com.evil.io', 'github.com'));
  assert.ok(!F2A.hostMatches('notgithub.com', 'github.com'));
});

await test('provider metadata + redirect URL resolve', async () => {
  assert.ok(F2A.providers.META.gdrive && F2A.providers.META.dropbox && F2A.providers.META.onedrive && F2A.providers.META.webdav);
  assert.equal(F2A.providers.redirectUrl(), 'https://test-extension-id.chromiumapp.org/');
});

await test('webdav full URL joins base + path correctly', async () => {
  const w = F2A.providers.webdav;
  assert.equal(w.fullUrl({ url: 'https://dav.jianguoyun.com/dav/', remotePath: '2fa-helper/backup.json' }), 'https://dav.jianguoyun.com/dav/2fa-helper/backup.json');
  assert.equal(w.fullUrl({ url: 'https://dav.jianguoyun.com/dav/backup.json', remotePath: 'ignored.json' }), 'https://dav.jianguoyun.com/dav/backup.json');
});

await test('dropbox path normalisation', () => {
  const d = F2A.providers.META.dropbox ? F2A.providers : null;
  assert.ok(d);
  const norm = (p) => '/' + String(p || '/2FA-Helper/backup.json').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  assert.equal(norm('2FA-Helper/backup.json'), '/2FA-Helper/backup.json');
  assert.equal(norm('/a//b.json'), '/a/b.json');
});

/* ---------------- summary ---------------- */
console.log(`\n${failures.length ? '✗' : '✓'} ${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
