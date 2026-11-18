/* 2FA Helper — backup targets: WebDAV, Google Drive, Dropbox, OneDrive (classic script)
   All network I/O lives here and runs inside the background context, so host
   permissions (not page CORS) govern the requests. */
(function (root) {
  'use strict';
  const F2A = (root.F2A = root.F2A || {});
  const api = F2A.api;

  const META = {
    none: { id: 'none', label: '未启用', kind: 'none', fields: [], cost: 'free' },
    folder: {
      id: 'folder', label: '文件夹同步（零配置）', kind: 'local',
      fields: ['path'],
      cost: 'free',
      help: '把加密备份直接写进「下载/2FA-Helper/」：让 OneDrive / iCloud / 坚果云 / Google Drive 桌面客户端同步这个文件夹即可。不用注册、不用填任何密钥。',
    },
    s3: {
      id: 's3', label: '对象存储 (S3 兼容)', kind: 'keys',
      fields: ['endpoint', 'region', 'bucket', 'keyPath', 'accessKey', 'secretKey'],
      cost: 'free',
      help: '填 AccessKey / SecretKey 即可，无需任何开发者后台。支持 AWS S3、Cloudflare R2、Backblaze B2、MinIO，以及阿里云 OSS / 腾讯云 COS 的 S3 兼容端点（这类服务商请用「测试连接」确认签名可用）。',
    },
    webdav: {
      id: 'webdav', label: 'WebDAV（坚果云 / Nextcloud / 群晖）', kind: 'basic',
      fields: ['url', 'username', 'password', 'remotePath'],
      cost: 'free',
      help: '坚果云地址形如 https://dav.jianguoyun.com/dav/2fa-helper/backup.json，密码请使用「应用密码」。',
    },
    gdrive: {
      id: 'gdrive', label: 'Google Drive', kind: 'oauth',
      fields: ['clientId', 'clientSecret', 'filePath'],
      cost: 'oauth',
      help: '需要自建 OAuth 客户端（Web 应用类型），并把下方的回调地址加入已获授权的重定向 URI。',
    },
    dropbox: {
      id: 'dropbox', label: 'Dropbox', kind: 'oauth',
      fields: ['appKey', 'filePath'],
      cost: 'oauth',
      help: '在 Dropbox App Console 创建 Scoped App，权限勾选 files.content.write / files.content.read，使用 PKCE 无需 App Secret。',
    },
    onedrive: {
      id: 'onedrive', label: 'OneDrive（Microsoft 账户）', kind: 'oauth',
      fields: ['clientId', 'tenant', 'filePath'],
      cost: 'oauth',
      help: '在 Azure 应用注册中创建「移动和桌面应用程序」，添加「Web」平台重定向 URI，启用公共客户端流。',
    },
  };

  const SCOPES = {
    gdrive: 'https://www.googleapis.com/auth/drive.file',
    dropbox: 'files.content.read files.content.write',
    onedrive: 'Files.ReadWrite.AppFolder offline_access',
  };

  /* ---------- small helpers ---------- */
  function b64url(bytes) {
    return F2A.bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function pkce() {
    const verifier = b64url(F2A.randomBytes(48));
    const digest = await root.crypto.subtle.digest('SHA-256', F2A.utf8Encode(verifier));
    return { verifier, challenge: b64url(new Uint8Array(digest)) };
  }

  async function fetchJson(url, opts = {}, timeoutMs = 30000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (e) { /* not json */ }
      if (!res.ok) {
        const detail = (json && (json.error_description || json.error?.message || json.error || json.message)) || text.slice(0, 300);
        const err = new Error(`HTTP ${res.status} ${res.statusText} — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
        err.status = res.status;
        err.body = json || text;
        throw err;
      }
      return { json, text, res };
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('请求超时：' + url);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  function redirectUrl() {
    try { return api.identity.getRedirectURL(); } catch (e) { return ''; }
  }

  function tokenCache(secrets, id) { return (secrets.tokens && secrets.tokens[id]) || null; }

  async function saveToken(id, token) {
    const secrets = await F2A.vault.getSecrets();
    const tokens = Object.assign({}, secrets.tokens || {});
    tokens[id] = token;
    await F2A.vault.setSecrets({ tokens });
  }

  async function clearToken(id) {
    const secrets = await F2A.vault.getSecrets();
    const tokens = Object.assign({}, secrets.tokens || {});
    delete tokens[id];
    await F2A.vault.setSecrets({ tokens });
  }

  /* ---------- generic OAuth (authorization code + PKCE) ---------- */
  async function runAuthFlow(authUrl) {
    if (!api.identity || !api.identity.launchWebAuthFlow) {
      throw new Error('当前浏览器不支持 identity.launchWebAuthFlow，请手动粘贴访问令牌');
    }
    let redirect;
    try {
      redirect = await api.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
    } catch (e) {
      const msg = String(e && e.message || e);
      if (/cancel|did not approve|closed by user/i.test(msg)) throw new Error('已取消授权');
      throw new Error('授权窗口失败：' + msg);
    }
    if (!redirect) throw new Error('授权未返回结果');
    const u = new URL(redirect);
    const err = u.searchParams.get('error');
    if (err) throw new Error('授权被拒绝：' + err + ' ' + (u.searchParams.get('error_description') || ''));
    const code = u.searchParams.get('code');
    if (!code) throw new Error('回调地址中没有 code 参数');
    return code;
  }

  /* ============ Google Drive ============ */
  const gdrive = {
    async authorize(interactive = true) {
      const settings = await F2A.vault.getSettings();
      const cfg = settings.providers.gdrive;
      const secrets = await F2A.vault.getSecrets();
      if (!cfg.clientId) throw new Error('请先填写 Google Client ID');
      const cached = tokenCache(secrets, 'gdrive');
      if (cached && cached.access_token && cached.expiry - 60000 > Date.now()) return cached.access_token;

      if (cached && cached.refresh_token) {
        try { return await this.refresh(cached.refresh_token); } catch (e) { /* fall through to full flow */ }
      }
      if (!interactive) throw new Error('需要先连接 Google Drive');

      const { verifier, challenge } = await pkce();
      const params = new URLSearchParams({
        client_id: cfg.clientId,
        response_type: 'code',
        scope: SCOPES.gdrive,
        redirect_uri: redirectUrl(),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
      });
      const code = await runAuthFlow('https://accounts.google.com/o/oauth2/v2/auth?' + params);

      const body = new URLSearchParams({
        client_id: cfg.clientId,
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUrl(),
      });
      const secret = secrets.gdriveSecret || cfg.clientSecret;
      if (secret) body.set('client_secret', secret);
      const { json } = await fetchJson('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const token = {
        access_token: json.access_token,
        refresh_token: json.refresh_token || (cached && cached.refresh_token) || '',
        expiry: Date.now() + (json.expires_in || 3600) * 1000,
      };
      await saveToken('gdrive', token);
      return token.access_token;
    },

    async refresh(refreshToken) {
      const settings = await F2A.vault.getSettings();
      const secrets = await F2A.vault.getSecrets();
      const body = new URLSearchParams({
        client_id: settings.providers.gdrive.clientId,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      });
      const secret = secrets.gdriveSecret || settings.providers.gdrive.clientSecret;
      if (secret) body.set('client_secret', secret);
      const { json } = await fetchJson('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const token = {
        access_token: json.access_token,
        refresh_token: refreshToken,
        expiry: Date.now() + (json.expires_in || 3600) * 1000,
      };
      await saveToken('gdrive', token);
      return token.access_token;
    },

    async findFile(token, name) {
      const q = encodeURIComponent(`name='${name.replace(/'/g, "\\'")}' and trashed=false`);
      const { json } = await fetchJson(
        `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&pageSize=1&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime)`,
        { headers: { Authorization: 'Bearer ' + token } }
      );
      return (json.files && json.files[0]) || null;
    },

    async upload(token, content, cfg) {
      const name = cfg.filePath || '2fa-helper-backup.json';
      const existing = cfg.fileId ? { id: cfg.fileId } : await this.findFile(token, name);
      if (existing) {
        await fetchJson(`https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media&fields=id`, {
          method: 'PATCH',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: content,
        });
        return { location: `Google Drive: ${name}` };
      }
      const boundary = 'f2a' + F2A.uid();
      const body =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify({ name, mimeType: 'application/json', appProperties: { app: '2fa-helper' } }) +
        `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` + content + `\r\n--${boundary}--`;
      const { json } = await fetchJson('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      });
      await F2A.vault.setSettings({ providers: { gdrive: { fileId: json.id } } });
      return { location: `Google Drive: ${name}` };
    },

    async download(token, cfg) {
      const name = cfg.filePath || '2fa-helper-backup.json';
      let id = cfg.fileId;
      if (!id) {
        const found = await this.findFile(token, name);
        if (!found) throw new Error(`云端没有找到 ${name}，请先执行一次备份`);
        id = found.id;
      }
      const { text } = await fetchJson(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, {
        headers: { Authorization: 'Bearer ' + token },
      });
      return text;
    },
  };

  /* ============ Dropbox ============ */
  const dropbox = {
    async authorize(interactive = true) {
      const settings = await F2A.vault.getSettings();
      const cfg = settings.providers.dropbox;
      if (!cfg.appKey) throw new Error('请先填写 Dropbox App Key');
      const secrets = await F2A.vault.getSecrets();
      const cached = tokenCache(secrets, 'dropbox');
      if (cached && cached.access_token && cached.expiry - 60000 > Date.now()) return cached.access_token;
      if (cached && cached.refresh_token) {
        try { return await this.refresh(cached.refresh_token); } catch (e) { /* re-auth */ }
      }
      if (!interactive) throw new Error('需要先连接 Dropbox');

      const { verifier, challenge } = await pkce();
      const params = new URLSearchParams({
        client_id: cfg.appKey,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        token_access_type: 'offline',
        redirect_uri: redirectUrl(),
      });
      const code = await runAuthFlow('https://www.dropbox.com/oauth2/authorize?' + params);
      const body = new URLSearchParams({
        code,
        grant_type: 'authorization_code',
        client_id: cfg.appKey,
        code_verifier: verifier,
        redirect_uri: redirectUrl(),
      });
      const { json } = await fetchJson('https://api.dropboxapi.com/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const token = {
        access_token: json.access_token,
        refresh_token: json.refresh_token || '',
        expiry: Date.now() + (json.expires_in || 14400) * 1000,
      };
      await saveToken('dropbox', token);
      return token.access_token;
    },

    async refresh(refreshToken) {
      const settings = await F2A.vault.getSettings();
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: settings.providers.dropbox.appKey,
      });
      const { json } = await fetchJson('https://api.dropboxapi.com/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const token = {
        access_token: json.access_token,
        refresh_token: refreshToken,
        expiry: Date.now() + (json.expires_in || 14400) * 1000,
      };
      await saveToken('dropbox', token);
      return token.access_token;
    },

    normalizePath(p) {
      const s = '/' + String(p || '/2FA-Helper/backup.json').replace(/^\/+/, '');
      return s.replace(/\/{2,}/g, '/');
    },

    async upload(token, content, cfg) {
      const path = this.normalizePath(cfg.filePath);
      await fetchJson('https://content.dropboxapi.com/2/files/upload', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/octet-stream',
          'Dropbox-API-Arg': JSON.stringify({ path, mode: 'overwrite', autorename: false, mute: true }),
        },
        body: content,
      }, 60000);
      return { location: 'Dropbox: ' + path };
    },

    async download(token, cfg) {
      const path = this.normalizePath(cfg.filePath);
      const { text } = await fetchJson('https://content.dropboxapi.com/2/files/download', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Dropbox-API-Arg': JSON.stringify({ path }) },
      }, 60000);
      return text;
    },
  };

  /* ============ OneDrive ============ */
  const onedrive = {
    tenant() { return 'common'; },

    async tenantOf() {
      const settings = await F2A.vault.getSettings();
      return settings.providers.onedrive.tenant || 'common';
    },

    async authorize(interactive = true) {
      const settings = await F2A.vault.getSettings();
      const cfg = settings.providers.onedrive;
      if (!cfg.clientId) throw new Error('请先填写 Microsoft 应用（客户端）ID');
      const secrets = await F2A.vault.getSecrets();
      const cached = tokenCache(secrets, 'onedrive');
      if (cached && cached.access_token && cached.expiry - 60000 > Date.now()) return cached.access_token;
      if (cached && cached.refresh_token) {
        try { return await this.refresh(cached.refresh_token); } catch (e) { /* re-auth */ }
      }
      if (!interactive) throw new Error('需要先连接 OneDrive');

      const tenant = await this.tenantOf();
      const { verifier, challenge } = await pkce();
      const params = new URLSearchParams({
        client_id: cfg.clientId,
        response_type: 'code',
        redirect_uri: redirectUrl(),
        response_mode: 'query',
        scope: SCOPES.onedrive,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      const code = await runAuthFlow(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?` + params);
      const body = new URLSearchParams({
        client_id: cfg.clientId,
        scope: SCOPES.onedrive,
        code,
        redirect_uri: redirectUrl(),
        grant_type: 'authorization_code',
        code_verifier: verifier,
      });
      const { json } = await fetchJson(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const token = {
        access_token: json.access_token,
        refresh_token: json.refresh_token || '',
        expiry: Date.now() + (json.expires_in || 3600) * 1000,
      };
      await saveToken('onedrive', token);
      return token.access_token;
    },

    async refresh(refreshToken) {
      const settings = await F2A.vault.getSettings();
      const tenant = settings.providers.onedrive.tenant || 'common';
      const body = new URLSearchParams({
        client_id: settings.providers.onedrive.clientId,
        scope: SCOPES.onedrive,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      });
      const { json } = await fetchJson(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const token = {
        access_token: json.access_token,
        refresh_token: json.refresh_token || refreshToken,
        expiry: Date.now() + (json.expires_in || 3600) * 1000,
      };
      await saveToken('onedrive', token);
      return token.access_token;
    },

    appPath(cfg) {
      return String(cfg.filePath || '2fa-helper-backup.json').replace(/^\/+/, '');
    },

    async upload(token, content, cfg) {
      const path = this.appPath(cfg);
      await fetchJson(`https://graph.microsoft.com/v1.0/me/drive/special/approot:/${encodeURI(path)}:/content`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: content,
      }, 60000);
      return { location: 'OneDrive 应用文件夹: ' + path };
    },

    async download(token, cfg) {
      const path = this.appPath(cfg);
      const { text } = await fetchJson(`https://graph.microsoft.com/v1.0/me/drive/special/approot:/${encodeURI(path)}:/content`, {
        headers: { Authorization: 'Bearer ' + token },
      }, 60000);
      return text;
    },
  };

  /* ============ WebDAV ============ */
  const webdav = {
    async cfg() {
      const settings = await F2A.vault.getSettings();
      const secrets = await F2A.vault.getSecrets();
      const c = settings.providers.webdav;
      if (!c.url) throw new Error('请先填写 WebDAV 地址');
      return { url: c.url, username: c.username, password: secrets.webdavPassword || '', remotePath: c.remotePath || 'backup.json' };
    },

    fullUrl(c) {
      const base = c.url.replace(/\/+$/, '');
      const path = String(c.remotePath || '').replace(/^\/+/, '');
      if (!path) return base + '/';
      // if base already points at a file, use as-is
      if (/\.json$/i.test(base)) return base;
      return base + '/' + path;
    },

    headers(c, extra) {
      const h = Object.assign({}, extra || {});
      const user = c.username || '';
      if (user || c.password) {
        const raw = F2A.utf8Encode(`${user}:${c.password}`);
        let bin = '';
        for (const b of raw) bin += String.fromCharCode(b);
        h.Authorization = 'Basic ' + root.btoa(bin);
      }
      return h;
    },

    async ensurePermission(url) {
      let origin;
      try {
        origin = new URL(url).origin + '/*';
      } catch (e) {
        throw new Error('WebDAV 地址格式不正确：' + url);
      }
      try {
        if (await api.permissions.contains({ origins: [origin] })) return true;
        const granted = await api.permissions.request({ origins: [origin] });
        if (!granted) {
          throw new Error(`未获得 ${origin} 的访问权限，无法备份。请重新点击「测试连接」并在浏览器弹窗中允许。`);
        }
        return true;
      } catch (e) {
        if (e && /未获得/.test(e.message || '')) throw e;
        // permissions API 不可用的浏览器：直接尝试请求
        return true;
      }
    },

    async mkcolParents(c) {
      const target = new URL(this.fullUrl(c));
      const parts = target.pathname.split('/').filter(Boolean);
      parts.pop(); // drop filename
      let path = '';
      for (const part of parts) {
        path += '/' + encodeURIComponent(part);
        try {
          await fetch(new URL(path, target.origin).toString(), {
            method: 'MKCOL', headers: this.headers(c),
          });
        } catch (e) { /* ignore: already exists or not allowed */ }
      }
    },

    async upload(token, content, cfg) {
      // always merge in the stored secret — `cfg` from settings has no password
      const c = await this.cfg();
      const target = this.fullUrl(c);
      await this.ensurePermission(target);
      await this.mkcolParents(c);
      const res = await fetch(target, { method: 'PUT', headers: this.headers(c, { 'Content-Type': 'application/json; charset=utf-8' }), body: content });
      if (!res.ok) throw new Error(`WebDAV 上传失败：HTTP ${res.status} ${res.statusText}（401 检查用户名/应用密码，403/404 检查路径是否存在）`);
      return { location: 'WebDAV: ' + target };
    },

    async download(token, cfg) {
      const c = await this.cfg();
      const target = this.fullUrl(c);
      await this.ensurePermission(target);
      const res = await fetch(target, { method: 'GET', headers: this.headers(c) });
      if (res.status === 404) throw new Error('云端没有备份文件，请先执行一次备份');
      if (!res.ok) throw new Error(`WebDAV 下载失败：HTTP ${res.status} ${res.statusText}`);
      return await res.text();
    },

    async test() {
      const c = await this.cfg();
      const target = this.fullUrl(c);
      await this.ensurePermission(target);
      const res = await fetch(target, { method: 'GET', headers: this.headers(c) });
      if (res.status === 401 || res.status === 403) throw new Error('认证失败（401/403），请检查用户名与应用密码');
      if (res.status === 404) return { ok: true, message: '连接正常，目标文件尚不存在（首次备份会创建）' };
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return { ok: true, message: '连接正常，云端已存在备份文件' };
    },
  };

  /* ============ 文件夹同步（零配置）：写进「下载」目录，交给系统网盘客户端 ============ */
  const folder = {
    path(cfg) {
      const raw = String((cfg && cfg.path) || '2FA-Helper/2fa-helper-backup.json').replace(/^\/+/, '');
      return raw.includes('.') ? raw : raw.replace(/\/+$/, '') + '/2fa-helper-backup.json';
    },

    async upload(token, content, cfg) {
      if (!api.downloads) throw new Error('当前浏览器不支持 downloads API，无法写入下载目录');
      const filename = this.path(cfg);
      let url;
      let blobUrl = null;
      if (typeof URL.createObjectURL === 'function') {
        blobUrl = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
        url = blobUrl;
      } else {
        // Chromium MV3 service worker: no createObjectURL
        url = 'data:application/json;charset=utf-8;base64,' + F2A.bytesToB64(F2A.utf8Encode(content));
      }
      try {
        await api.downloads.download({ url, filename, saveAs: false, conflictAction: 'overwrite' });
      } finally {
        if (blobUrl) setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      }
      return { location: '下载目录: ' + filename };
    },

    async download() {
      throw new Error('文件夹模式只负责写入：请在设置页用「从文件恢复」选择下载目录里的 2fa-helper-backup.json');
    },

    async test() {
      const settings = await F2A.vault.getSettings();
      return { ok: true, message: '将写入 下载目录/' + this.path(settings.providers.folder) + '（请确认网盘客户端已同步该文件夹）' };
    },
  };

  /* ============ 对象存储：S3 兼容 + SigV4 预签名 ============ */
  const S3_PRESETS = [
    { id: 'aws', label: 'AWS S3', endpoint: 'https://s3.us-east-1.amazonaws.com', region: 'us-east-1' },
    { id: 'r2', label: 'Cloudflare R2', endpoint: 'https://<账户ID>.r2.cloudflarestorage.com', region: 'auto' },
    { id: 'b2', label: 'Backblaze B2', endpoint: 'https://s3.us-west-004.backblazeb2.com', region: 'us-west-004' },
    { id: 'minio', label: 'MinIO / 自建', endpoint: 'http://127.0.0.1:9000', region: 'us-east-1' },
    { id: 'oss', label: '阿里云 OSS（S3 兼容）', endpoint: 'https://s3.oss-cn-hangzhou.aliyuncs.com', region: 'cn-hangzhou' },
    { id: 'cos', label: '腾讯云 COS（S3 兼容）', endpoint: 'https://cos.ap-guangzhou.myqcloud.com', region: 'ap-guangzhou' },
  ];

  const s3 = {
    async cfg() {
      const settings = await F2A.vault.getSettings();
      const secrets = await F2A.vault.getSecrets();
      const c = settings.providers.s3 || {};
      if (!c.endpoint) throw new Error('请先填写 S3 Endpoint');
      if (!c.bucket) throw new Error('请先填写 Bucket');
      if (!c.accessKey) throw new Error('请先填写 AccessKey');
      if (!secrets.s3Secret) throw new Error('请先填写 SecretKey');
      return {
        endpoint: String(c.endpoint).replace(/\/+$/, ''),
        region: c.region || 'us-east-1',
        bucket: c.bucket,
        accessKey: c.accessKey,
        secretKey: secrets.s3Secret,
        keyPath: c.keyPath || '2fa-helper/backup.json',
      };
    },

    objectPath(c) {
      const key = String(c.keyPath || '2fa-helper/backup.json').replace(/^\/+/, '');
      return '/' + c.bucket + '/' + key.split('/').map((seg) => encodeURIComponent(seg)).join('/');
    },

    async presign(method, c, expires = 900) {
      const subtle = root.crypto.subtle;
      const enc = F2A.utf8Encode;
      const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
      const sha256Hex = async (str) => hex(await subtle.digest('SHA-256', enc(str)));
      const hmacRaw = async (keyBytes, msg) => {
        const key = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        return new Uint8Array(await subtle.sign('HMAC', key, enc(msg)));
      };
      const uriEncode = (str, encodeSlash) => {
        let out = '';
        for (const ch of String(str)) {
          if (/[A-Za-z0-9\-_.~]/.test(ch)) out += ch;
          else if (ch === '/' && !encodeSlash) out += ch;
          else out += [...enc(ch)].map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('');
        }
        return out;
      };

      const now = new Date();
      const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
      const dateStamp = amzDate.slice(0, 8);
      const scope = `${dateStamp}/${c.region}/s3/aws4_request`;
      const host = new URL(c.endpoint).host;

      const query = [
        ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
        ['X-Amz-Credential', `${c.accessKey}/${scope}`],
        ['X-Amz-Date', amzDate],
        ['X-Amz-Expires', String(expires)],
        ['X-Amz-SignedHeaders', 'host'],
      ].map(([k, v]) => uriEncode(k, true) + '=' + uriEncode(v, true)).join('&');

      const canonicalUri = this.objectPath(c);
      const canonicalRequest = [
        method, canonicalUri, query, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD',
      ].join('\n');
      const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');

      let key = await hmacRaw(enc('AWS4' + c.secretKey), dateStamp);
      key = await hmacRaw(key, c.region);
      key = await hmacRaw(key, 's3');
      key = await hmacRaw(key, 'aws4_request');
      const signature = hex(await hmacRaw(key, stringToSign));

      return `${c.endpoint}${canonicalUri}?${query}&X-Amz-Signature=${signature}`;
    },

    async ensurePermission(url) {
      try {
        const origin = new URL(url).origin + '/*';
        if (await api.permissions.contains({ origins: [origin] })) return true;
        const granted = await api.permissions.request({ origins: [origin] });
        if (!granted) throw new Error(`未获得 ${origin} 的访问权限，无法上传到对象存储`);
        return true;
      } catch (e) {
        if (e && /未获得/.test(e.message || '')) throw e;
        return true;
      }
    },

    async upload(token, content, cfg) {
      const c = await this.cfg();
      const url = await this.presign('PUT', c);
      await this.ensurePermission(url);
      const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: content });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`S3 上传失败：HTTP ${res.status} ${res.statusText}${body ? ' — ' + body.slice(0, 200) : ''}（403 多为 AccessKey/Secret/region 不匹配，404 检查 bucket 名）`);
      }
      return { location: `对象存储: ${c.bucket}/${c.keyPath}` };
    },

    async download(token, cfg) {
      const c = await this.cfg();
      const url = await this.presign('GET', c);
      await this.ensurePermission(url);
      const res = await fetch(url, { method: 'GET' });
      if (res.status === 404) throw new Error('云端没有备份文件，请先执行一次备份');
      if (!res.ok) throw new Error(`S3 下载失败：HTTP ${res.status} ${res.statusText}`);
      return await res.text();
    },

    async test() {
      const c = await this.cfg();
      const url = await this.presign('GET', c);
      await this.ensurePermission(url);
      const res = await fetch(url, { method: 'GET' });
      if (res.status === 404) return { ok: true, message: 's3 连接正常，目标对象尚不存在（首次备份会创建）' };
      if (res.status === 403) throw new Error('签名被拒绝（403）：请核对 AccessKey / SecretKey / region 是否与该端点匹配');
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return { ok: true, message: '连接正常，云端已存在备份对象' };
    },
  };

  /* ============ WebDAV 常见网盘预设（账号 / 应用密码直连） ============ */
  const WEBDAV_PRESETS = [
    { id: 'custom', label: '自定义', template: '', user: '', help: '直接填写完整的 WebDAV 文件地址。' },
    {
      id: 'jianguoyun', label: '坚果云', template: 'https://dav.jianguoyun.com/dav/2fa-helper/backup.json',
      user: '坚果云账号邮箱', help: '密码必须用「账户信息 → 安全选项 → 添加应用密码」生成的密码。',
    },
    {
      id: 'nextcloud', label: 'Nextcloud', template: 'https://your-host/remote.php/dav/files/<用户名>/2fa/backup.json',
      user: 'Nextcloud 用户名', help: '把 your-host 和 <用户名> 换成实际值；也可以在设置里生成「应用密码」。',
    },
    {
      id: 'synology', label: '群晖 NAS', template: 'https://your-nas:5006/2fa/backup.json',
      user: 'DSM 用户名', help: '需在套件中心安装 WebDAV Server，端口 5006=HTTPS / 5005=HTTP。',
    },
    {
      id: 'alist', label: 'AList / OpenList 网关', template: 'http://your-alist:5244/dav/2fa-helper/backup.json',
      user: 'AList 用户名', help: '在 AList 里把 Google Drive / OneDrive / Dropbox / 百度网盘挂载好，扩展只需连 AList 的 /dav —— 一次配置即可「直连」任意网盘。',
    },
    {
      id: 'pcloud', label: 'pCloud', template: 'https://webdav.pcloud.com/2fa-helper/backup.json',
      user: 'pCloud 账号邮箱', help: '欧盟区账号用 https://ewebdav.pcloud.com；密码用账号密码即可。',
    },
    {
      id: 'koofr', label: 'Koofr', template: 'https://app.koofr.net/dav/Koofr/2fa-helper/backup.json',
      user: 'Koofr 邮箱', help: '可在 Koofr 设置里生成专用应用密码。',
    },
    {
      id: 'yandex', label: 'Yandex Disk', template: 'https://webdav.yandex.ru/2fa-helper/backup.json',
      user: 'Yandex 账号', help: '需要先在 Yandex ID 里生成「应用密码」。',
    },
    {
      id: 'infinicloud', label: 'InfiniCLOUD', template: 'https://your-id.teracloud.jp/dav/2fa-helper/backup.json',
      user: 'InfiniCLOUD 账号', help: '在「应用程序连接」里启用 WebDAV 并获取专用密码。',
    },
  ];

  const IMPLS = { gdrive, dropbox, onedrive, webdav, s3, folder };

  /* ---------- public API ---------- */

  /** Validate the current configuration and (for OAuth) run the consent flow. */
  async function connect(id) {
    const impl = IMPLS[id];
    if (!impl) throw new Error('未知的备份渠道: ' + id);
    if (id === 'webdav' || id === 's3' || id === 'folder') {
      const test = await impl.test();
      return { ok: true, message: test.message };
    }
    await impl.authorize(true);
    return { ok: true, message: '授权成功，令牌已保存在本地，可随时断开' };
  }

  async function disconnect(id) {
    await clearToken(id);
    return { ok: true };
  }

  async function isConnected(id) {
    if (id === 'webdav') {
      const c = await F2A.vault.getSecrets();
      return !!(c.webdavPassword && (await F2A.vault.getSettings()).providers.webdav.url);
    }
    const secrets = await F2A.vault.getSecrets();
    const t = tokenCache(secrets, id);
    return !!(t && (t.refresh_token || (t.access_token && t.expiry > Date.now())));
  }

  /**
   * Upload a JSON string to a provider.
   * @returns {{ok:true, location:string}}
   */
  async function upload(id, content) {
    const impl = IMPLS[id];
    if (!impl) throw new Error('未选择备份渠道');
    const settings = await F2A.vault.getSettings();
    const cfg = (settings.providers[id] || {});
    let token = null;
    if (impl.authorize) token = await impl.authorize(false);
    const res = await impl.upload(token, content, cfg);
    return Object.assign({ ok: true }, res);
  }

  /** Download the remote JSON string. */
  async function download(id) {
    const impl = IMPLS[id];
    if (!impl) throw new Error('未选择备份渠道');
    const settings = await F2A.vault.getSettings();
    const cfg = (settings.providers[id] || {});
    let token = null;
    if (impl.authorize) token = await impl.authorize(false);
    return await impl.download(token, cfg);
  }

  async function test(id) {
    if (id === 'webdav' || id === 's3' || id === 'folder') return await IMPLS[id].test();
    const impl = IMPLS[id];
    if (!impl) throw new Error('未选择备份渠道');
    const token = await impl.authorize(true);
    if (id === 'gdrive') {
      await gdrive.findFile(token, (await F2A.vault.getSettings()).providers.gdrive.filePath || '2fa-helper-backup.json');
      return { ok: true, message: 'Google Drive 连接正常' };
    }
    if (id === 'dropbox') {
      await fetchJson('https://api.dropboxapi.com/2/users/get_current_account', {
        method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: 'null',
      });
      return { ok: true, message: 'Dropbox 连接正常' };
    }
    if (id === 'onedrive') {
      const { json } = await fetchJson('https://graph.microsoft.com/v1.0/me/drive/special/approot', {
        headers: { Authorization: 'Bearer ' + token },
      });
      return { ok: true, message: 'OneDrive 连接正常：' + (json.name || 'App Folder') };
    }
    return { ok: true, message: '连接正常' };
  }

  Object.assign(F2A, {
    providers: {
      META, SCOPES, WEBDAV_PRESETS, S3_PRESETS,
      list: () => Object.values(META), connect, disconnect, isConnected, upload, download, test, redirectUrl, webdav, s3, folder,
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
