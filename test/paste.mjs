/* 批量粘贴解析：一次粘多条 otpauth
   node test/paste.mjs */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (p) => readFileSync(path.join(ROOT, 'src/lib', p), 'utf8');
for (const f of ['util.js', 'totp.js']) (0, eval)(read(f));
const F2A = globalThis.F2A;
const { parseBatch } = F2A.otpauth;

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failures.push(name); console.log(`  ✗ ${name}\n      ${e.message}`); }
}

const T = (issuer, account, secret) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;

console.log('\n批量粘贴');

await test('三行 otpauth 一次解析出来', () => {
  const text = [T('GitHub', 'me@example.com', 'JBSWY3DPEHPK3PXP'), T('Google', 'me@example.com', 'KRSXG5CTMVRXEZLU'), T('AWS', 'root', 'GEZDGNBVGY3TQOJQ')].join('\n');
  const { entries, failed } = parseBatch(text);
  assert.equal(entries.length, 3);
  assert.equal(failed.length, 0);
  assert.deepEqual(entries.map((e) => e.issuer), ['GitHub', 'Google', 'AWS']);
  assert.equal(entries[0].secret, 'JBSWY3DPEHPK3PXP');
  assert.equal(entries[2].account, 'root');
});

await test('链接夹在文字里、带句末标点也能认出来', () => {
  const text = `我的两个账号：\n1. ${T('GitHub', 'a@x.com', 'JBSWY3DPEHPK3PXP')}，这个是主力。\n2.《${T('Slack', 'b@x.com', 'GEZDGNBVGY3TQOJQ')}》备用。\n结束。`;
  const { entries, failed } = parseBatch(text);
  assert.equal(entries.length, 2, JSON.stringify(failed));
  assert.deepEqual(entries.map((e) => e.issuer), ['GitHub', 'Slack']);
});

await test('一行坏掉不拖垮整批，并且报出行号', () => {
  const text = [T('GitHub', 'a@x.com', 'JBSWY3DPEHPK3PXP'), 'otpauth://totp/Broken:x?issuer=Broken', T('AWS', 'root', 'GEZDGNBVGY3TQOJQ')].join('\n');
  const { entries, failed } = parseBatch(text);
  assert.equal(entries.length, 2);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].line, 2);
  assert.match(failed[0].reason, /secret/);
});

await test('重复粘贴同一条只算一次', () => {
  const one = T('GitHub', 'a@x.com', 'JBSWY3DPEHPK3PXP');
  const { entries } = parseBatch([one, one, one].join('\n'));
  assert.equal(entries.length, 1);
});

await test('migration 包会展开成多条，还能和其他链接混在一起', () => {
  // 用官方 protobuf 结构手工拼一个两条的迁移包
  const b64 = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const one = (secret, name) => {
    const sec = Buffer.from(F2A.b32decode(secret));
    const inner = [...Buffer.from([0x0a, sec.length]), ...sec, 0x12, name.length, ...Buffer.from(name)];
    return [0x0a, inner.length, ...inner, 0x10, 2, 0x18, 1];
  };
  const a = one('JBSWY3DPEHPK3PXP', 'alice');
  const b = one('GEZDGNBVGY3TQOJQ', 'bob');
  const payload = [...a, ...b, 0x22, 0x0a, 0x08, 0x01, 0x10, 0x01];
  const text = `otpauth-migration://offline?data=${encodeURIComponent(b64(payload))}\n${T('AWS', 'root', 'KRSXG5CTMVRXEZLU')}`;
  const { entries } = parseBatch(text);
  assert.equal(entries.length, 3, JSON.stringify(entries.map((e) => e.account)));
});

await test('「账户 / 密钥」文本块也能导', () => {
  const text = '账户: me@example.com\n密钥: jbsw y3dp ehpk 3pxp\n\n账号: other@example.com\n发行方: Bank\nSecret: GEZDGNBVGY3TQOJQ';
  const { entries } = parseBatch(text);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].secret, 'JBSWY3DPEHPK3PXP');
  assert.equal(entries[0].account, 'me@example.com');
  assert.equal(entries[1].issuer, 'Bank');
  assert.equal(entries[1].secret, 'GEZDGNBVGY3TQOJQ');
});

await test('只有密钥没有账户标识时不猜（避免误判）', () => {
  assert.throws(() => parseBatch('密钥: JBSWY3DPEHPK3PXP'), /没找到/);
});

await test('完全认不出时给出可读的错误', () => {
  assert.throws(() => parseBatch('随便写点什么'), /没找到 otpauth/);
  assert.throws(() => parseBatch('   '), /内容为空/);
});

await test('base32 归一化：小写 / 空格 / 缺少的填充都能吃', () => {
  const text = `账号: a@x.com\n密钥: gezd gnbv gy3t qojq`;
  const { entries } = parseBatch(text);
  assert.equal(entries[0].secret, 'GEZDGNBVGY3TQOJQ');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
