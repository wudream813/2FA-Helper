/**
 * 对象存储（S3 兼容）与「文件夹同步」测试
 *  1. SigV4 预签名 URL 与 AWS 官方参考实现 botocore 逐字节比对
 *  2. 起一个自己校验签名的 HTTP 服务器，跑完整 put/get/test 流程
 *  3. 文件夹模式：写入下载目录的路径与内容
 *   node test/s3.mjs
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHmac, createHash } from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const LIBS = ['util.js', 'totp.js', 'crypto.js', 'vault.js', 'providers.js', 'backup.js', 'sync.js'];

let passed = 0;
const fails = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { fails.push(name); console.log('  ✗ ' + name + '\n      ' + e.message); }
}

/* ---------- 用固定时间构造设备，方便与 botocore 对齐 ---------- */
const FIXED_MS = Date.parse('2026-11-18T03:04:05.000Z');

function makeDevice({ fixedMs = FIXED_MS } = {}) {
  const local = new Map();
  const session = new Map();
  const downloadsCalls = [];
  const sandbox = {
    console, crypto: webcrypto, TextEncoder, TextDecoder, Blob, URL,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 5)), clearTimeout,
    BigInt,
    fetch: (...args) => globalThis.fetch(...args),
    chrome: {
      runtime: { id: 'test', getManifest: () => ({ version: '1.1.0' }), onMessage: { addListener() {} } },
      storage: {
        local: area(local), session: area(session), sync: area(new Map()), onChanged: { addListener() {} },
      },
      alarms: { onAlarm: { addListener() {} }, async getAll() { return []; }, async get() { return null; }, async clear() {}, create() {} },
      action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
      identity: { getRedirectURL: () => 'https://test.chromiumapp.org/' },
      permissions: { async contains() { return true; }, async request() { return true; } },
      downloads: {
        async download(options) { downloadsCalls.push(options); return downloadsCalls.length; },
      },
    },
  };
  const ctx = vm.createContext(sandbox);
  // freeze time so presigned URLs are comparable with botocore
  vm.runInContext(`
    (function(){
      const RealDate = Date;
      const fixed = ${fixedMs};
      class FakeDate extends RealDate {
        constructor(...args) { if (args.length === 0) super(fixed); else super(...args); }
        static now() { return fixed; }
      }
      globalThis.Date = FakeDate;
    })();
  `, ctx);
  for (const f of LIBS) vm.runInContext(readFileSync(path.join(ROOT, 'src/lib', f), 'utf8'), ctx);
  return { F2A: ctx.F2A, local, session, downloadsCalls, ctx };
}

function area(map) {
  return {
    async get(keys) {
      if (keys === null || keys === undefined) return Object.fromEntries([...map].map(([k, v]) => [k, structuredClone(v)]));
      const out = {};
      for (const k of typeof keys === 'string' ? [keys] : keys) if (map.has(k)) out[k] = structuredClone(map.get(k));
      return out;
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) map.set(k, structuredClone(v)); },
    async remove(keys) { for (const k of [].concat(keys)) map.delete(k); },
    async clear() { map.clear(); },
  };
}

const AK = 'AKIAIOSFODNN7EXAMPLE';
const SK = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

/* ============ 1. 与 botocore 比对 ============ */
const CASES = [
  {
    name: 'AWS S3 基础路径',
    endpoint: 'https://s3.us-east-1.amazonaws.com', region: 'us-east-1',
    bucket: 'mybucket', keyPath: '2fa-helper/backup.json',
  },
  {
    name: 'R2 风格端点 + 非 ASCII 键名',
    endpoint: 'https://abc123.r2.cloudflarestorage.com', region: 'auto',
    bucket: 'backups.bucket', keyPath: '备份/2fa helper/backup 01.json',
  },
  {
    name: 'MinIO 本地端口',
    endpoint: 'http://127.0.0.1:9000', region: 'us-east-1',
    bucket: 'vault', keyPath: 'a/b/c.json',
  },
  {
    name: 'EU 区域',
    endpoint: 'https://s3.eu-west-1.amazonaws.com', region: 'eu-west-1',
    bucket: 'Vault-2026', keyPath: 'x.json',
  },
];

function botocoreUrls(cases, method, expires) {
  const script = `
import json, sys
from botocore.session import get_session
from botocore.config import Config

cases = json.loads(sys.argv[1])
session = get_session()
out = []
for c in cases:
    client = session.create_client(
        's3',
        region_name=c['region'],
        endpoint_url=c['endpoint'],
        aws_access_key_id=c['ak'],
        aws_secret_access_key=c['sk'],
        config=Config(signature_version='s3v4', s3={'addressing_style': 'path'}),
    )
    out.append(client.generate_presigned_url(
        c['op'], Params={'Bucket': c['bucket'], 'Key': c['key']}, ExpiresIn=c['expires']))
print(json.dumps(out))
`;
  const payload = JSON.stringify(cases.map((c) => ({
    endpoint: c.endpoint, region: c.region, bucket: c.bucket, key: c.keyPath,
    ak: AK, sk: SK, op: method, expires,
  })));
  const out = execFileSync('python3', ['-c', script, payload], { encoding: 'utf8' });
  return JSON.parse(out);
}

/** X-Amz-Date (20261118T095706Z) → epoch ms */
function amzDateToMs(amzDate) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
  if (!m) throw new Error('无法解析 X-Amz-Date: ' + amzDate);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

console.log('\nSigV4 预签名（与 botocore 逐字节比对）');
{
  let reference = null;
  try {
    reference = botocoreUrls(CASES, 'put_object', 900);
  } catch (e) {
    console.log('      （跳过：本机没有 botocore）', String(e.message).slice(0, 150));
  }
  if (reference) {
    for (let i = 0; i < CASES.length; i++) {
      await test(`预签名一致：${CASES[i].name}`, async () => {
        const amzDate = new URL(reference[i]).searchParams.get('X-Amz-Date');
        const dev = makeDevice({ fixedMs: amzDateToMs(amzDate) });
        const c = {
          endpoint: CASES[i].endpoint, region: CASES[i].region, bucket: CASES[i].bucket,
          accessKey: AK, secretKey: SK, keyPath: CASES[i].keyPath,
        };
        const mine = await dev.F2A.providers.s3.presign('PUT', c, 900);
        assert.equal(mine, reference[i]);
      });
    }
  }
}

/* ============ 2. 独立校验签名的服务器 ============ */
const files = new Map();
const AWS_HOST = 's3.test.local';
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, `http://${AWS_HOST}`);
    const q = Object.fromEntries(url.searchParams.entries());
    const signature = q['X-Amz-Signature'] || '';
    delete q['X-Amz-Signature'];

    // 独立重建 SigV4（与扩展里的 WebCrypto 实现是两套代码）
    const canonicalQuery = Object.keys(q).sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(q[k]).replace(/%2F/g, '%2F')}`)
      .join('&');
    const canonicalRequest = [
      req.method, url.pathname, canonicalQuery,
      `host:${AWS_HOST}\n`, 'host', 'UNSIGNED-PAYLOAD',
    ].join('\n');
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      q['X-Amz-Date'],
      q['X-Amz-Credential'].split('/').slice(1).join('/'),
      createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
    ].join('\n');
    const dateStamp = q['X-Amz-Credential'].split('/')[1];
    const region = q['X-Amz-Credential'].split('/')[2];
    const hmac = (key, msg) => createHmac('sha256', key).update(msg, 'utf8').digest();
    let k = hmac('AWS4' + SK, dateStamp);
    k = hmac(k, region);
    k = hmac(k, 's3');
    k = hmac(k, 'aws4_request');
    const expected = createHmac('sha256', k).update(stringToSign, 'utf8').digest('hex');

    if (expected !== signature) {
      res.writeHead(403, { 'Content-Type': 'application/xml' });
      return res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
    }
    const key = decodeURIComponent(url.pathname);
    if (req.method === 'PUT') { files.set(key, body); res.writeHead(200); return res.end(); }
    if (req.method === 'GET') {
      if (!files.has(key)) { res.writeHead(404); return res.end('NoSuchKey'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(files.get(key));
    }
    res.writeHead(405); res.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// fetch 到测试服务器的请求改写到随机端口（Host 保持 s3.test.local 以便签名一致）
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input).replace('http://' + AWS_HOST, `http://127.0.0.1:${port}`);
  const headers = Object.assign({}, init && init.headers);
  headers.host = AWS_HOST;
  return realFetch(url, Object.assign({}, init, { headers }));
};

console.log('\n对象存储完整流程（服务器独立验签）');
const dev = makeDevice();
await dev.F2A.vault.unlock('');
await dev.F2A.vault.upsertEntry({ issuer: 'S3-Test', account: 'me@x.com', secret: 'JBSWY3DPEHPK3PXP' });
await dev.F2A.vault.setMasterPassword('s3-pass-1');
await dev.F2A.vault.setSettings({
  providers: { s3: { endpoint: 'http://' + AWS_HOST, region: 'us-east-1', bucket: 'vault', accessKey: AK, keyPath: '2fa-helper/backup.json' } },
});
await dev.F2A.vault.setSecrets({ s3Secret: SK });

await test('测试连接：对象不存在时报「首次备份会创建」', async () => {
  const res = await dev.F2A.providers.test('s3');
  assert.equal(res.ok, true);
  assert.match(res.message, /尚不存在/);
});

await test('上传：PUT 到桶内路径，服务器验签通过', async () => {
  const res = await dev.F2A.backup.upload('s3');
  assert.equal(res.ok, true);
  assert.match(res.location, /对象存储: vault\/2fa-helper\/backup.json/);
  assert.ok(files.has('/vault/2fa-helper/backup.json'), '对象应已写入');
});

await test('内容确实是加密信封', async () => {
  const stored = JSON.parse(files.get('/vault/2fa-helper/backup.json'));
  assert.equal(stored.format, 'f2a-vault');
  assert.equal(stored.encrypted, true);
  assert.ok(!JSON.stringify(stored).includes('JBSWY3DPEHPK3PXP'));
});

await test('下载 + 从对象存储恢复', async () => {
  const text = await dev.F2A.providers.download('s3');
  assert.match(text, /f2a-vault/);
  const res = await dev.F2A.backup.restoreFromProvider('s3', 's3-pass-1');
  assert.equal(res.ok, true);
  assert.equal(res.entries, 1);
});

await test('SecretKey 错误时服务器 403，错误信息可读', async () => {
  await dev.F2A.vault.setSecrets({ s3Secret: 'wrong-secret' });
  await assert.rejects(() => dev.F2A.backup.upload('s3'), /403|SignatureDoesNotMatch/);
  const status = await dev.F2A.vault.getStatus();
  assert.equal(status.lastBackupOk, false);
  await dev.F2A.vault.setSecrets({ s3Secret: SK });
});

await test('缺少配置时给出明确提示', async () => {
  await dev.F2A.vault.setSettings({ providers: { s3: { bucket: '' } } });
  await assert.rejects(() => dev.F2A.providers.test('s3'), /Bucket/);
  await dev.F2A.vault.setSettings({ providers: { s3: { bucket: 'vault' } } });
});

/* ============ 3. 文件夹同步 ============ */
console.log('\n文件夹同步（零配置）');
const dev2 = makeDevice();
delete dev2.ctx.URL?.createObjectURL;
await dev2.F2A.vault.unlock('');
await dev2.F2A.vault.upsertEntry({ issuer: 'Folder-Test', account: 'a@b.c', secret: 'JBSWY3DPEHPK3PXP' });
await dev2.F2A.vault.setMasterPassword('folder-pass-1');

await test('写入下载目录并带上默认子路径', async () => {
  const res = await dev2.F2A.backup.upload('folder');
  assert.equal(res.ok, true);
  assert.match(res.location, /2FA-Helper\/2fa-helper-backup.json/);
  const call = dev2.downloadsCalls.at(-1);
  assert.equal(call.filename, '2FA-Helper/2fa-helper-backup.json');
  assert.equal(call.saveAs, false);
  assert.equal(call.conflictAction, 'overwrite');
  assert.match(call.url, /^data:application\/json;charset=utf-8;base64,/);
  const payload = Buffer.from(call.url.split(',')[1], 'base64').toString('utf8');
  const env = JSON.parse(payload);
  assert.equal(env.format, 'f2a-vault');
  assert.equal(env.encrypted, true);
});

await test('自定义路径也能生效（只写目录时自动补文件名）', async () => {
  await dev2.F2A.vault.setSettings({ providers: { folder: { path: 'MyVault' } } });
  await dev2.F2A.backup.upload('folder');
  assert.equal(dev2.downloadsCalls.at(-1).filename, 'MyVault/2fa-helper-backup.json');
});

await test('恢复时提示改用「从文件恢复」而不是静默失败', async () => {
  await assert.rejects(() => dev2.F2A.providers.download('folder'), /从文件恢复/);
});

/* ============ 4. WebDAV 预设 ============ */
console.log('\nWebDAV 网盘预设');
await test('预设齐全且地址合法', () => {
  const presets = dev2.F2A.providers.WEBDAV_PRESETS;
  const ids = presets.map((p) => p.id);
  for (const need of ['jianguoyun', 'nextcloud', 'synology', 'alist', 'pcloud']) {
    assert.ok(ids.includes(need), '缺少预设: ' + need);
  }
  for (const p of presets) {
    if (p.template) {
      if (!/your-|your_|<.*>/.test(p.template)) new URL(p.template); // 占位符之外的必须是合法 URL
      assert.ok(p.help, p.id + ' 应有说明');
    }
  }
});

await test('S3 预设齐全', () => {
  const ids = dev2.F2A.providers.S3_PRESETS.map((p) => p.id);
  for (const need of ['aws', 'r2', 'b2', 'minio']) assert.ok(ids.includes(need), '缺少预设: ' + need);
});

server.close();
console.log(`\n${fails.length ? '✗' : '✓'} ${passed} passed, ${fails.length} failed\n`);
if (fails.length) process.exit(1);
