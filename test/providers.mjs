/**
 * Network-level tests for the four backup targets.
 *  - WebDAV runs against a real HTTP server (methods, headers, auth).
 *  - Google Drive / Dropbox / OneDrive use a fetch interceptor that asserts the
 *    exact request shape each API requires, then returns a realistic response.
 *   node test/providers.mjs
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const store = { local: new Map(), session: new Map() };

function area(map) {
  return {
    async get(keys) {
      const out = {};
      for (const k of typeof keys === 'string' ? [keys] : keys) if (map.has(k)) out[k] = structuredClone(map.get(k));
      return out;
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) map.set(k, structuredClone(v)); },
    async remove(keys) { for (const k of [].concat(keys)) map.delete(k); },
    async clear() { map.clear(); },
  };
}

globalThis.chrome = {
  storage: { local: area(store.local), session: area(store.session), onChanged: { addListener() {} } },
  runtime: { id: 'test-id', getManifest: () => ({ version: '1.0.0' }), onMessage: { addListener() {} } },
  alarms: { onAlarm: { addListener() {} }, async getAll() { return []; }, async clear() {}, create() {} },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  identity: { getRedirectURL: () => 'https://test-id.chromiumapp.org/' },
  permissions: { async contains() { return true; }, async request() { return true; } },
  downloads: { async download() { return 1; } },
};

for (const f of ['util.js', 'totp.js', 'crypto.js', 'vault.js', 'providers.js', 'backup.js']) {
  (0, eval)(readFileSync(path.join(ROOT, 'src/lib', f), 'utf8'));
}
const F2A = globalThis.F2A;
const P = F2A.providers;

let passed = 0;
const fails = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { fails.push(name); console.log('  ✗ ' + name + '\n      ' + e.message); }
}

/* ============ WebDAV over a real socket ============ */
const davState = { files: new Map(), dirs: new Set(), requests: [] };
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    davState.requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    const authed = req.headers.authorization === 'Basic ' + Buffer.from('user@example.com:app-pass').toString('base64');
    if (!authed) { res.writeHead(401); return res.end('unauthorized'); }
    if (req.method === 'MKCOL') { davState.dirs.add(req.url); res.writeHead(201); return res.end(); }
    if (req.method === 'PUT') { davState.files.set(req.url, body); res.writeHead(201); return res.end(); }
    if (req.method === 'GET') {
      if (!davState.files.has(req.url)) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(davState.files.get(req.url));
    }
    res.writeHead(405); res.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const davUrl = `http://127.0.0.1:${port}/dav/2fa-helper/backup.json`;

console.log('\nWebDAV（真实 HTTP 服务器）');
await test('未配置地址时给出明确错误', async () => {
  await F2A.vault.setSettings({ providers: { webdav: { url: '' } } });
  await assert.rejects(() => P.test('webdav'), /请先填写 WebDAV 地址/);
});

await test('测试连接：文件不存在时返回 404 但仍算连通', async () => {
  await F2A.vault.setSettings({ providers: { webdav: { url: davUrl, username: 'user@example.com' } } });
  await F2A.vault.setSecrets({ webdavPassword: 'app-pass' });
  const res = await P.test('webdav');
  assert.equal(res.ok, true);
  assert.match(res.message, /尚不存在/);
});

await test('上传：会自动 MKCOL 建目录并 PUT 内容', async () => {
  davState.requests.length = 0;
  const res = await P.upload('webdav', JSON.stringify({ hello: 'world' }));
  assert.equal(res.ok, true);
  assert.match(res.location, /WebDAV: http/);
  const methods = davState.requests.map((r) => r.method);
  assert.ok(methods.includes('MKCOL'), '应先尝试创建目录');
  assert.ok(methods.includes('PUT'));
  assert.equal(davState.files.get('/dav/2fa-helper/backup.json'), JSON.stringify({ hello: 'world' }));
});

await test('下载：原样取回内容', async () => {
  const text = await P.download('webdav');
  assert.equal(text, JSON.stringify({ hello: 'world' }));
});

await test('密码错误时给出 401 提示', async () => {
  await F2A.vault.setSecrets({ webdavPassword: 'wrong' });
  await assert.rejects(() => P.test('webdav'), /401|认证失败/);
  await F2A.vault.setSecrets({ webdavPassword: 'app-pass' });
});

await test('Restore 流程：下载 → 校验 → 覆盖本地保管库', async () => {
  await F2A.vault.unlock('');
  await F2A.vault.upsertEntry({ issuer: 'WebDAV-Test', account: 'a@b.c', secret: 'JBSWY3DPEHPK3PXP' });
  await F2A.vault.setMasterPassword('pw-123456');
  await P.upload('webdav', (await F2A.backup.build()).json);
  await F2A.vault.upsertEntry({ issuer: 'Should-Vanish', account: 'x', secret: 'GEZDGNBVGY3TQOJQ' });
  const res = await F2A.backup.restoreFromProvider('webdav', 'pw-123456');
  assert.equal(res.ok, true);
  const st = await F2A.vault.state();
  const issuers = st.data.entries.map((e) => e.issuer);
  assert.ok(issuers.includes('WebDAV-Test'));
  assert.ok(!issuers.includes('Should-Vanish'), '恢复后不应残留备份之后新增的条目');
});

/* ============ OAuth providers via fetch interceptor ============ */
await F2A.vault.setSecrets({
  tokens: {
    gdrive: { access_token: 'g-token', refresh_token: 'g-refresh', expiry: Date.now() + 3600_000 },
    dropbox: { access_token: 'd-token', refresh_token: 'd-refresh', expiry: Date.now() + 3600_000 },
    onedrive: { access_token: 'o-token', refresh_token: 'o-refresh', expiry: Date.now() + 3600_000 },
  },
});
await F2A.vault.setSettings({
  providers: {
    gdrive: { clientId: 'client.apps.googleusercontent.com', filePath: '2fa-helper-backup.json', fileId: 'file-123' },
    dropbox: { appKey: 'appkey', filePath: '/2FA-Helper/backup.json' },
    onedrive: { clientId: 'client-id', tenant: 'common', filePath: '2fa-helper-backup.json' },
  },
});
await F2A.vault.unlock('pw-123456');

const seen = [];
let driveHasFile = true;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const entry = { url: u, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body };
  seen.push(entry);
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  const text = (t, status = 200) => new Response(t, { status });

  // --- Google Drive ---
  if (u.startsWith('https://www.googleapis.com/drive/v3/files?')) {
    assert.equal(entry.headers.Authorization, 'Bearer g-token');
    if (!driveHasFile) return json({ files: [] });
    return json({ files: [{ id: 'file-123', name: '2fa-helper-backup.json', modifiedTime: '2026-01-01T00:00:00Z' }] });
  }
  if (u.startsWith('https://www.googleapis.com/upload/drive/v3/files/file-123')) {
    assert.equal(entry.method, 'PATCH', '已存在的文件应走 PATCH 更新');
    assert.equal(entry.headers['Content-Type'], 'application/json');
    return json({ id: 'file-123' });
  }
  if (u.startsWith('https://www.googleapis.com/upload/drive/v3/files?')) {
    assert.equal(entry.method, 'POST');
    assert.match(entry.headers['Content-Type'], /multipart\/related; boundary=/);
    assert.match(entry.body, /--f2a[0-9a-f]+/);
    return json({ id: 'new-file-456' });
  }
  if (/^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/[\w-]+\?alt=media$/.test(u)) {
    assert.equal(entry.headers.Authorization, 'Bearer g-token');
    return text('{"from":"drive"}');
  }

  // --- Dropbox ---
  if (u === 'https://content.dropboxapi.com/2/files/upload') {
    const arg = JSON.parse(entry.headers['Dropbox-API-Arg']);
    assert.equal(arg.path, '/2FA-Helper/backup.json');
    assert.equal(arg.mode, 'overwrite');
    assert.equal(entry.headers['Content-Type'], 'application/octet-stream');
    assert.equal(entry.headers.Authorization, 'Bearer d-token');
    return json({ path_display: arg.path, size: String((entry.body || '').length) });
  }
  if (u === 'https://content.dropboxapi.com/2/files/download') {
    const arg = JSON.parse(entry.headers['Dropbox-API-Arg']);
    assert.equal(arg.path, '/2FA-Helper/backup.json');
    return text('{"from":"dropbox"}');
  }
  if (u === 'https://api.dropboxapi.com/2/users/get_current_account') {
    return json({ account_id: 'dbid:1', name: { display_name: 'Tester' } });
  }

  // --- OneDrive ---
  if (u.startsWith('https://graph.microsoft.com/v1.0/me/drive/special/approot:/') && entry.method === 'PUT') {
    assert.match(u, /approot:\/2fa-helper-backup\.json:\/content$/);
    assert.equal(entry.headers.Authorization, 'Bearer o-token');
    return json({ id: 'item-1', name: '2fa-helper-backup.json' });
  }
  if (u.startsWith('https://graph.microsoft.com/v1.0/me/drive/special/approot:/') && entry.method === 'GET') {
    return text('{"from":"onedrive"}');
  }
  if (u === 'https://graph.microsoft.com/v1.0/me/drive/special/approot') {
    return json({ name: 'App Folder', id: 'approot' });
  }

  // --- token refresh endpoints (should not be hit: tokens are still valid) ---
  if (/oauth2\.googleapis\.com\/token|dropboxapi\.com\/oauth2\/token|login\.microsoftonline\.com/.test(u)) {
    throw new Error('不应触发刷新，令牌还在有效期内: ' + u);
  }

  throw new Error('未预期的请求: ' + entry.method + ' ' + u);
};

const intercept = globalThis.fetch;

console.log('\nGoogle Drive（请求形状校验）');
await test('上传：更新已有 fileId（PATCH + media）', async () => {
  const res = await P.upload('gdrive', '{"v":1}');
  assert.equal(res.ok, true);
  assert.match(res.location, /Google Drive/);
});

await test('首次上传：multipart/related 创建新文件', async () => {
  driveHasFile = false;
  await F2A.vault.setSettings({ providers: { gdrive: { fileId: '' } } });
  const res = await P.upload('gdrive', '{"v":2}');
  assert.equal(res.ok, true);
  const create = seen.find((r) => r.url.startsWith('https://www.googleapis.com/upload/drive/v3/files?'));
  assert.ok(create, '应发送创建请求');
  const fileId = (await F2A.vault.getSettings()).providers.gdrive.fileId;
  assert.equal(fileId, 'new-file-456', '创建后应记住 fileId 以便下次就地更新');
  driveHasFile = true;
});

await test('下载：alt=media 取回内容', async () => {
  const text = await P.download('gdrive');
  assert.equal(text, '{"from":"drive"}');
});

console.log('\nDropbox');
await test('上传：Dropbox-API-Arg 与路径规范化正确', async () => {
  const res = await P.upload('dropbox', '{"v":3}');
  assert.equal(res.ok, true);
  assert.equal(res.location, 'Dropbox: /2FA-Helper/backup.json');
});

await test('下载 + 测试连接', async () => {
  assert.equal(await P.download('dropbox'), '{"from":"dropbox"}');
  const res = await P.test('dropbox');
  assert.equal(res.ok, true);
});

console.log('\nOneDrive');
await test('上传到 App Folder', async () => {
  const res = await P.upload('onedrive', '{"v":4}');
  assert.equal(res.ok, true);
  assert.match(res.location, /OneDrive/);
});

await test('下载 + 测试连接', async () => {
  assert.equal(await P.download('onedrive'), '{"from":"onedrive"}');
  const res = await P.test('onedrive');
  assert.equal(res.ok, true);
  assert.match(res.message, /OneDrive 连接正常/);
});

console.log('\n内置客户端（一键连接）');
await test('未填 Client ID 时自动使用内置 ID 发起授权', async () => {
  // 清空令牌与 clientId，模拟「普通用户什么都没填，直接点连接」
  // 令牌置为「已过期且无 refresh token」→ 必然走交互式授权
  await F2A.vault.setSecrets({ tokens: { onedrive: { access_token: '', refresh_token: '', expiry: 0 } } });
  await F2A.vault.setSettings({ providers: { onedrive: { clientId: '', tenant: 'common', filePath: '2fa-helper-backup.json' } } });

  let authUrl = '';
  const prevFlow = globalThis.chrome.identity.launchWebAuthFlow;
  globalThis.chrome.identity.launchWebAuthFlow = async ({ url }) => {
    authUrl = url;
    return 'https://test-id.chromiumapp.org/?code=the-code';
  };
  const prevFetch = globalThis.fetch;
  let tokenBody = '';
  globalThis.fetch = async (u, o = {}) => {
    if (String(u).includes('login.microsoftonline.com') && String(u).endsWith('/token')) {
      tokenBody = String(o.body);
      return new Response(JSON.stringify({ access_token: 'new-token', refresh_token: 'r', expires_in: 3600 }), { status: 200 });
    }
    return prevFetch(u, o);
  };
  try {
    const token = await P.connect('onedrive').then(() => F2A.vault.getSecrets());
    assert.ok(token, '应保存令牌');
    assert.match(authUrl, /client_id=5a7712eb-cd4c-4920-8893-073538113163/, '授权 URL 应带上内置客户端 ID');
    assert.match(authUrl, /code_challenge_method=S256/, '必须用 PKCE');
    assert.match(authUrl, /scope=Files\.ReadWrite\.AppFolder\+offline_access/, '只申请 App Folder 权限');
    assert.ok(!/client_secret/.test(tokenBody), '公开客户端不能提交 client_secret');
  } finally {
    globalThis.fetch = prevFetch;
    globalThis.chrome.identity.launchWebAuthFlow = prevFlow;
  }
});

await test('内置 ID 是公开标识、不含任何密钥', async () => {
  assert.equal(P.builtinClient('onedrive'), '5a7712eb-cd4c-4920-8893-073538113163');
  assert.equal(P.builtinClient('gdrive'), '', 'Google 未内置时应返回空串，退回用户自填');
});

await test('用户自己填了 Client ID 时以用户的为准', async () => {
  await F2A.vault.setSecrets({ tokens: { onedrive: { access_token: '', refresh_token: '', expiry: 0 } } });
  await F2A.vault.setSettings({ providers: { onedrive: { clientId: 'mine', tenant: 'common', filePath: '2fa-helper-backup.json' } } });
  let authUrl = '';
  const prevFlow = globalThis.chrome.identity.launchWebAuthFlow;
  globalThis.chrome.identity.launchWebAuthFlow = async ({ url }) => { authUrl = url; throw new Error('captured'); };
  try { await P.connect('onedrive').catch(() => {}); } finally { globalThis.chrome.identity.launchWebAuthFlow = prevFlow; }
  assert.match(authUrl, /client_id=mine/);
});

await test('Google：内置 ID + 内置 secret 时也能一键连（secret 只从代码里取）', async () => {
  await F2A.vault.setSecrets({ tokens: { gdrive: { access_token: '', refresh_token: '', expiry: 0 } }, gdriveSecret: '' });
  await F2A.vault.setSettings({ providers: { gdrive: { clientId: '', filePath: '2fa-helper-backup.json' } } });
  P.BUILTIN_CLIENTS.gdrive = 'demo.apps.googleusercontent.com';
  P.BUILTIN_SECRETS.gdrive = 'demo-secret';
  let authUrl = '';
  let tokenBody = '';
  const prevFlow = globalThis.chrome.identity.launchWebAuthFlow;
  const prevFetch = globalThis.fetch;
  globalThis.chrome.identity.launchWebAuthFlow = async ({ url }) => {
    authUrl = url;
    return 'https://test-id.chromiumapp.org/?code=c';
  };
  globalThis.fetch = async (u, o = {}) => {
    if (String(u) === 'https://oauth2.googleapis.com/token') {
      tokenBody = String(o.body);
      return new Response(JSON.stringify({ access_token: 'g-new', refresh_token: 'gr', expires_in: 3600 }), { status: 200 });
    }
    return prevFetch(u, o);
  };
  try {
    await P.connect('gdrive').catch((e) => { throw e; });
    assert.match(authUrl, /client_id=demo\.apps\.googleusercontent\.com/);
    assert.match(authUrl, /scope=https%3A%2F%2Fwww\.googleapis\.com%2Fauth%2Fdrive\.file/, '只申请 drive.file（非敏感范围）');
    assert.match(authUrl, /code_challenge_method=S256/, '仍然使用 PKCE');
    assert.match(authUrl, /access_type=offline/, '要 refresh token 才能定时备份');
    assert.match(tokenBody, /client_secret=demo-secret/, 'Google 的 Web 客户端换 token 需要 secret');
    assert.match(tokenBody, /code_verifier=/, 'PKCE verifier 必须随请求提交');
  } finally {
    globalThis.fetch = prevFetch;
    globalThis.chrome.identity.launchWebAuthFlow = prevFlow;
    delete P.BUILTIN_CLIENTS.gdrive;
    delete P.BUILTIN_SECRETS.gdrive;
    // 恢复后续用例依赖的 fixture
    await F2A.vault.setSettings({ providers: { gdrive: { clientId: 'client.apps.googleusercontent.com', filePath: '2fa-helper-backup.json' } } });
  }
});

console.log('\n错误处理');
await test('远程 404 时提示先备份', async () => {
  globalThis.fetch = async (u) => {
    if (String(u).includes('/dav/')) return new Response('nope', { status: 404 });
    return realFetch(u);
  };
  await assert.rejects(() => P.download('webdav'), /云端没有备份文件/);
  globalThis.fetch = realFetch;
});

await test('Google 401 会被包装成可读错误', async () => {
  globalThis.fetch = async (u) => {
    if (String(u).includes('googleapis.com')) {
      return new Response(JSON.stringify({ error: { message: 'Invalid Credentials' } }), { status: 401 });
    }
    return realFetch(u);
  };
  await assert.rejects(() => P.download('gdrive'), /HTTP 401.*Invalid Credentials/);
  globalThis.fetch = realFetch;
});

await test('备份失败会写入错误状态，成功会记录时间', async () => {
  globalThis.fetch = async () => new Response('{"error_summary":"path/not_found/"}', { status: 409 });
  await assert.rejects(() => F2A.backup.upload('dropbox'), /409/);
  let status = await F2A.vault.getStatus();
  assert.equal(status.lastBackupOk, false, '失败应标记为 false');
  assert.match(status.lastError, /409/);

  globalThis.fetch = intercept;
  await F2A.backup.upload('dropbox');
  status = await F2A.vault.getStatus();
  assert.equal(status.lastBackupOk, true);
  assert.ok(status.lastBackupAt, '成功备份后应记录时间');
  assert.equal(status.lastError, '');
  globalThis.fetch = realFetch;
});

server.close();
console.log(`\n${fails.length ? '✗' : '✓'} ${passed} passed, ${fails.length} failed\n`);
if (fails.length) process.exit(1);
