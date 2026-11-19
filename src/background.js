/* 2FA Helper — background service worker / event page
   Owns: message routing, alarms, scheduled snapshots, cloud I/O, autofill answers. */
'use strict';

(function (root) {
  const LIB = ['lib/util.js', 'lib/totp.js', 'lib/crypto.js', 'lib/vault.js', 'lib/providers.js', 'lib/backup.js', 'lib/sync.js', 'lib/qr.js'];
  // Chromium service worker: pull the classic libs in. Firefox event page: manifest already did it.
  if (typeof importScripts === 'function' && !root.F2A) {
    for (const f of LIB) importScripts(f);
  } else if (typeof importScripts === 'function' && root.F2A && !root.F2A.vault) {
    for (const f of LIB) importScripts(f);
  }

  const F2A = root.F2A;
  const api = F2A.api;

  const log = (...a) => console.log('[2FA Helper]', ...a);
  const warn = (...a) => console.warn('[2FA Helper]', ...a);

  /* ---------------- helpers ---------------- */
  async function codes(entryIds, atMs) {
    const st = await F2A.vault.state();
    if (st.locked) { const e = new Error('已锁定'); e.code = 'LOCKED'; throw e; }
    const entries = (st.data.entries || []).filter((e) => e.kind !== 'passkey' && (!entryIds || entryIds.includes(e.id)));
    const out = {};
    for (const e of entries) {
      try {
        out[e.id] = await F2A.totp.generate(e, atMs);
      } catch (err) {
        out[e.id] = { error: String(err.message || err) };
      }
    }
    return out;
  }

  function b64urlEncode(str) {
    return F2A.bytesToB64(F2A.utf8Encode(str)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64urlDecode(text) {
    let s = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return F2A.utf8Decode(F2A.b64ToBytes(s));
  }

  /**
   * Understands every payload the extension can produce or consume:
   * otpauth://, otpauth-migration://, f2a-sync:v1:, f2a-passkey:v1:, plain JSON.
   */
  function parseScanned(text) {
    if (!text) throw new Error('内容为空');
    if (/^f2a-sync:/i.test(text)) {
      return { action: 'sync-join', code: text.replace(/^f2a-sync:v\d+:/i, '').replace(/^f2a-sync:/i, '') };
    }
    if (/^f2a-passkey:/i.test(text)) {
      const payload = JSON.parse(b64urlDecode(text.replace(/^f2a-passkey:v\d+:/i, '')));
      return { action: 'import', kind: 'passkey', entries: [{ kind: 'passkey', issuer: payload.rpName || payload.rpId, account: payload.userName, passkey: payload }] };
    }
    if (/^otpauth-migration:/i.test(text)) return { action: 'import', kind: 'otp', entries: F2A.otpauth.parseMigration(text) };
    if (/^otpauth:/i.test(text)) return { action: 'import', kind: 'otp', entries: [F2A.otpauth.parse(text)] };
    if (text.startsWith('{') || text.startsWith('[')) {
      const data = JSON.parse(text);
      if (data && data.format === 'f2a-vault') return { action: 'restore', text };
      const entries = F2A.otpauth.importFromJson(text);
      if (!entries.length) throw new Error('JSON 里没有可导入的条目');
      const passkeys = entries.filter((e) => e.kind === 'passkey');
      return { action: 'import', kind: passkeys.length === entries.length ? 'passkey' : 'otp', entries };
    }
    throw new Error('无法识别的二维码内容（需要 otpauth://、迁移包、本扩展条目码或备份文件）');
  }

  /* 二维码解码器按需加载：Chromium 的 SW 用 importScripts，Firefox 的
     background.scripts 已在 manifest 里静态引入，这里检测一下即可。 */
  let qrShot = null;
  function ensureDecoder() {
    if (typeof root.jsQR === 'function') return true;
    try {
      if (typeof importScripts === 'function') {
        importScripts('vendor/jsqr.js');
        return typeof root.jsQR === 'function';
      }
    } catch (e) { /* fall through */ }
    return typeof root.jsQR === 'function';
  }

  async function activeTab() {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    return (tabs && tabs[0]) || null;
  }

  /** Capture the visible area of the active tab as a PNG data URL. */
  async function captureVisible() {
    const tabsApi = api.tabs;
    if (!tabsApi || typeof tabsApi.captureVisibleTab !== 'function') {
      throw new Error('当前浏览器不支持截取页面');
    }
    let dataUrl;
    try {
      dataUrl = await tabsApi.captureVisibleTab(null, { format: 'png' });
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/permission|denied|activeTab/i.test(msg)) throw new Error('没有截取页面的权限，请把二维码截图后粘贴进来');
      if (/chrome:|edge:|about:|extension:\/\//i.test(msg)) throw new Error('无法截取浏览器内部页面');
      throw new Error('截取当前页面失败：' + msg);
    }
    if (!dataUrl || String(dataUrl).indexOf('data:image/') !== 0) throw new Error('截取当前页面失败');
    return dataUrl;
  }

  async function updateBadge() {
    try {
      const st = await F2A.vault.state();
      if (st.locked) {
        await api.action.setBadgeText({ text: '🔒' });
        await api.action.setBadgeBackgroundColor({ color: '#b45309' });
      } else {
        const n = (st.data && st.data.entries ? st.data.entries.length : 0);
        await api.action.setBadgeText({ text: n ? String(n) : '' });
        await api.action.setBadgeBackgroundColor({ color: '#1f7a5c' });
      }
    } catch (e) { /* action API may not exist in event page context */ }
  }

  /* ---------------- message router ---------------- */
  const routes = {
    'vault.state': async () => {
      const st = await F2A.vault.state();
      if (st.locked) return { locked: true, encryptionEnabled: true };
      const settings = await F2A.vault.getSettings();
      return {
        locked: false,
        encryptionEnabled: !!settings.encryptionEnabled,
        entries: (st.data.entries || []).map((e) => Object.assign({}, e, { secret: e.secret })),
        settings,
      };
    },

    'vault.unlock': async ({ password }) => {
      const res = await F2A.vault.unlock(password || '');
      await updateBadge();
      return { ok: true };
    },

    'vault.lock': async () => {
      await F2A.vault.lock();
      await updateBadge();
      return { ok: true };
    },

    'vault.touch': async () => { await F2A.vault.touch(); return { ok: true }; },

    'codes.get': async ({ ids, at }) => codes(ids, at),

    'entry.save': async ({ entry }) => {
      const saved = await F2A.vault.upsertEntry(entry);
      await updateBadge();
      return { ok: true, entry: saved };
    },

    'entry.delete': async ({ id }) => {
      await F2A.vault.deleteEntry(id);
      await updateBadge();
      return { ok: true };
    },

    'entry.import': async ({ entries, mode }) => {
      const res = await F2A.vault.importEntries(entries, { mode });
      await updateBadge();
      return Object.assign({ ok: true }, res);
    },

    'entry.parseOtpauth': async ({ uri }) => {
      const parsed = parseScanned(String(uri || '').trim());
      if (parsed.action === 'sync-join') throw new Error('这是同步配对码，请到设置页的「端到端同步」中导入');
      return { ok: true, entries: parsed.entries };
    },

    /* ---- 扫码 / 粘贴 统一入口 ---- */
    'scan.handle': async ({ text }) => parseScanned(String(text || '').trim()),

    /* 截取当前标签页，回传 PNG data URL（调用方自己解码） */
    'qr.capture': async () => ({ dataUrl: await captureVisible() }),

    /* 截取当前标签页 → 直接在原页面盖一层浮层让用户框选（不开新窗口） */
    'qr.select': async () => {
      const dataUrl = await captureVisible();
      qrShot = dataUrl;
      try { await api.storage.session.set({ qrShot: dataUrl }); } catch (e) { /* 可选 */ }
      const tab = await activeTab();
      if (!tab || tab.id == null) throw new Error('找不到当前标签页');
      try {
        const res = await api.tabs.sendMessage(tab.id, { type: 'overlay.open', shot: dataUrl });
        if (res && res.ok === false) throw new Error(res.error || '页面拒绝显示浮层');
      } catch (e) {
        qrShot = null;
        throw new Error('这个页面不能框选（浏览器内部页面或未注入脚本），请改用截图粘贴');
      }
      return { tabId: tab.id };
    },

    /* 浮层框选完成 → 只解码这一块 */
    'overlay.crop': async ({ rect, viewport }) => {
      if (!qrShot) {
        try { const st = await api.storage.session.get('qrShot'); qrShot = st && st.qrShot; } catch (e) { /* ignore */ }
      }
      if (!qrShot) throw new Error('截图已失效，请重新点 ▣');
      if (!ensureDecoder()) throw new Error('二维码解码器未加载');
      const text = await F2A.qr.decodeDataUrlRegion(qrShot, rect, viewport);
      if (!text) return { noQr: true };
      const parsed = parseScanned(text);
      if (parsed.action === 'sync-join') return { needsOptions: '这是同步配对码，请到设置页「端到端同步」中导入。' };
      if (parsed.action === 'restore') return { needsOptions: '这是加密备份文件，请到设置页的扫码导入里恢复。' };
      const imported = await F2A.vault.importEntries(parsed.entries, { mode: 'merge' });
      await updateBadge();
      const res = { total: imported.total };
      qrShot = null;
      return { imported: parsed.entries.length, total: res.total, label: parsed.entries[0] && (parsed.entries[0].issuer || parsed.entries[0].account) || '' };
    },

    /* ---- Passkey ---- */
    'passkey.generate': async () => {
      const pair = await root.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const spki = new Uint8Array(await root.crypto.subtle.exportKey('spki', pair.publicKey));
      const jwk = await root.crypto.subtle.exportKey('jwk', pair.privateKey);
      const b64url = F2A.bytesToB64(F2A.randomBytes(16)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return {
        ok: true,
        algorithm: -7,
        credentialId: b64url,
        publicKey: F2A.bytesToB64(spki),
        privateKeyJwk: JSON.stringify(jwk),
      };
    },

    'entry.qrPayload': async ({ id }) => {
      const st = await F2A.vault.requireData();
      const e = (st.data.entries || []).find((x) => x.id === id);
      if (!e) throw new Error('条目不存在');
      if (e.kind === 'passkey') {
        const pk = e.passkey || {};
        const safe = {
          rpId: pk.rpId, rpName: pk.rpName, userName: pk.userName, userDisplayName: pk.userDisplayName,
          userHandle: pk.userHandle, credentialId: pk.credentialId, publicKey: pk.publicKey,
          algorithm: pk.algorithm, signCount: pk.signCount, note: pk.note,
          hasPrivateKey: !!pk.privateKeyJwk,
        };
        return { ok: true, kind: 'passkey', text: 'f2a-passkey:v1:' + b64urlEncode(JSON.stringify(safe)) };
      }
      return { ok: true, kind: 'otp', text: F2A.otpauth.toUri(e) };
    },

    'entry.listAll': async () => {
      const st = await F2A.vault.requireData();
      return { ok: true, entries: st.data.entries || [] };
    },

    'entry.exportOne': async ({ id }) => {
      const st = await F2A.vault.requireData();
      const e = (st.data.entries || []).find((x) => x.id === id);
      if (!e) throw new Error('条目不存在');
      return { ok: true, entry: e };
    },

    /* ---- storage.sync 端到端同步 ---- */
    'sync.status': async () => F2A.sync.check(),
    'sync.enable': async () => F2A.sync.enable(),
    'sync.join': async ({ code }) => F2A.sync.join(code),
    'sync.push': async () => F2A.sync.push({ force: true }),
    'sync.pull': async ({ password }) => F2A.sync.pull(password),
    'sync.disable': async ({ wipeRemote }) => F2A.sync.disable({ wipeRemote: wipeRemote !== false }),
    'sync.code': async () => {
      const key = await F2A.sync.getKey();
      return { ok: true, code: key ? F2A.sync.formatCode(key) : '', raw: key, available: F2A.sync.available() };
    },

    'entry.exportUri': async ({ id }) => {
      const st = await F2A.vault.requireData();
      const e = (st.data.entries || []).find((x) => x.id === id);
      if (!e) throw new Error('条目不存在');
      return { ok: true, uri: F2A.otpauth.toUri(e) };
    },

    /* ---- settings & crypto ---- */
    'settings.get': async () => F2A.vault.getSettings(),
    'settings.set': async (msg) => {
      // accepts both { type, patch: {...} } and a flat { type, ...patch }
      const { type, patch, ...flat } = msg;
      const settings = await F2A.vault.setSettings(patch || flat);
      await F2A.backup.scheduleAll();
      if (patch && patch.sync) await F2A.sync.schedule();
      return { ok: true, settings };
    },
    'secrets.get': async () => {
      const s = await F2A.vault.getSecrets();
      return {
        hasWebdavPassword: !!s.webdavPassword,
        hasGdriveSecret: !!s.gdriveSecret,
        hasS3Secret: !!s.s3Secret,
        tokens: Object.fromEntries(Object.entries(s.tokens || {}).map(([k, v]) => [k, !!(v && v.access_token)])),
      };
    },
    'secrets.set': async ({ webdavPassword, gdriveSecret, s3Secret }) => {
      const patch = {};
      if (webdavPassword !== undefined) patch.webdavPassword = webdavPassword;
      if (gdriveSecret !== undefined) patch.gdriveSecret = gdriveSecret;
      if (s3Secret !== undefined) patch.s3Secret = s3Secret;
      await F2A.vault.setSecrets(patch);
      return { ok: true };
    },
    'crypto.setPassword': async ({ password, currentPassword }) => {
      if (!password || String(password).length < 6) throw new Error('主密码至少 6 位');
      await F2A.vault.setMasterPassword(String(password), currentPassword);
      await updateBadge();
      return { ok: true };
    },
    'crypto.removePassword': async ({ currentPassword }) => {
      await F2A.vault.removeMasterPassword(currentPassword);
      await updateBadge();
      return { ok: true };
    },

    /* ---- backup ---- */
    'providers.redirect': async () => ({ ok: true, url: F2A.providers.redirectUrl() }),
    'providers.connect': async ({ provider }) => F2A.providers.connect(provider),
    'providers.disconnect': async ({ provider }) => F2A.providers.disconnect(provider),
    'providers.test': async ({ provider }) => F2A.providers.test(provider),

    'backup.now': async ({ provider }) => F2A.backup.upload(provider),
    'backup.status': async () => F2A.vault.getStatus(),
    'backup.export': async ({ filename }) => F2A.backup.exportFile({ filename }),
    'backup.buildJson': async () => {
      const built = await F2A.backup.build();
      return { json: built.json, size: built.size };
    },
    'backup.snapshotNow': async () => F2A.backup.snapshot('manual'),

    'backup.snapshots': async () => {
      const list = await F2A.vault.listSnapshots();
      return list.map((s) => ({
        ts: s.ts,
        size: s.size,
        entries: (s.envelope && s.envelope.meta && s.envelope.meta.entryCount) || 0,
        encrypted: !!(s.envelope && s.envelope.encrypted),
      }));
    },
    'backup.snapshotDelete': async ({ ts }) => ({ ok: true, list: (await F2A.vault.deleteSnapshot(ts)).length }),
    'backup.snapshotRestore': async ({ ts, password }) => {
      const list = await F2A.vault.listSnapshots();
      const item = list.find((s) => s.ts === ts);
      if (!item) throw new Error('快照不存在');
      const res = await F2A.backup.applyRestore(item.envelope, password || '');
      await updateBadge();
      return res;
    },

    'backup.restoreFromProvider': async ({ provider, password }) => {
      const res = await F2A.backup.restoreFromProvider(provider, password);
      await updateBadge();
      return res;
    },

    'backup.inspect': async ({ text, password }) => {
      const info = await F2A.backup.inspect(text, password);
      return {
        encrypted: info.encrypted,
        needsPassword: !!info.needsPassword,
        entryCount: ((info.data && info.data.entries) || []).length,
        createdAt: info.envelope.createdAt,
        meta: info.meta,
      };
    },

    'backup.applyText': async ({ text, password }) => {
      const info = await F2A.backup.inspect(text, password);
      if (info.needsPassword) return { ok: false, needsPassword: true };
      const res = await F2A.backup.applyRestore(info.envelope, password || '');
      await updateBadge();
      return res;
    },

    /* ---- autofill ---- */
    'autofill.match': async ({ host }) => {
      const settings = await F2A.vault.getSettings();
      if (!settings.autofill || settings.autofill.enabled === false) return { limited: true, matches: [] };
      const st = await F2A.vault.state();
      if (st.locked) return { locked: true, matches: [] };
      const matches = (st.data.entries || []).filter((e) => e.kind !== 'passkey' && (e.urls || []).some((h) => F2A.hostMatches(host, h)));
      return {
        locked: false,
        matches: matches.map((e) => ({ id: e.id, issuer: e.issuer, account: e.account, type: e.type || 'totp' })),
      };
    },

    'autofill.code': async ({ id }) => {
      const c = await codes([id]);
      return { ok: true, code: c[id] };
    },
  };

  async function dispatch(msg) {
    const fn = routes[msg && msg.type];
    if (!fn) throw new Error('未知消息类型: ' + (msg && msg.type));
    return fn(msg);
  }

  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // only answer our own pages / content scripts
    if (!msg || typeof msg.type !== 'string') return false;
    dispatch(msg)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => {
        const err = { ok: false, error: String((e && e.message) || e), code: e && e.code };
        if (err.code !== 'LOCKED') warn(msg.type, err.error);
        sendResponse(err);
      });
    return true; // async response
  });

  /* ---------------- alarms ---------------- */
  api.alarms.onAlarm.addListener(async (alarm) => {
    try {
      if (alarm.name === F2A.backup.ALARM_SNAPSHOT) {
        const res = await F2A.backup.snapshot('auto');
        log('auto snapshot', res);
      } else if (alarm.name === F2A.backup.ALARM_BACKUP) {
        const res = await F2A.backup.runScheduledBackup();
        log('scheduled backup', res);
      } else if (alarm.name === F2A.sync.ALARM) {
        const settings = await F2A.vault.getSettings();
        if (settings.sync.enabled && settings.sync.autoPush && !F2A.sync.isSuppressed()) {
          const st = await F2A.sync.check();
          if (!st.remoteIsNewer) log('sync push', await F2A.sync.push());
          else log('sync: 云端更新，等待用户处理');
        }
      } else if (alarm.name === F2A.backup.ALARM_EXPORT) {
        const res = await F2A.backup.exportFile();
        log('scheduled export', res);
      }
    } catch (e) {
      warn('alarm failed', alarm.name, e.message);
      if (alarm.name === F2A.backup.ALARM_BACKUP) {
        await F2A.vault.setStatus({ lastBackupOk: false, lastError: String(e.message || e) });
      } else {
        await F2A.vault.setStatus({ lastError: String(e.message || e) });
      }
    }
  });

  /* ---------------- auto snapshot on change (debounced) ---------------- */
  let snapshotTimer = null;
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.vault) return;
    clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(async () => {
      try { await F2A.backup.snapshot('auto'); } catch (e) { warn('debounced snapshot failed', e.message); }
      try {
        const settings = await F2A.vault.getSettings();
        if (settings.sync.enabled && settings.sync.autoPush && !F2A.sync.isSuppressed() && (await F2A.sync.getKey())) {
          const st = await F2A.sync.check();
          if (!st.remoteIsNewer) await F2A.sync.push();
        }
      } catch (e) { warn('auto sync failed', e.message); }
    }, 10000);
  });

  api.runtime.onInstalled.addListener(async (details) => {
    log('installed', details.reason);
    try {
      const settings = await F2A.vault.getSettings();
      await F2A.vault.setSettings(settings);
      await F2A.backup.scheduleAll();
      await F2A.sync.schedule();
    } catch (e) { warn(e.message); }
    updateBadge();
  });

  api.runtime.onStartup.addListener(() => {
    F2A.backup.scheduleAll().catch(() => {});
    F2A.sync.schedule().catch(() => {});
    updateBadge();
  });

  updateBadge();
})(typeof globalThis !== 'undefined' ? globalThis : self);
