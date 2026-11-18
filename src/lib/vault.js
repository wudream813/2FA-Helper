/* 2FA Helper — storage layer / vault state machine (classic script) */
(function (root) {
  'use strict';
  const F2A = (root.F2A = root.F2A || {});
  const api = F2A.api;
  const C = F2A.vaultCrypto;

  const K_VAULT = 'vault';
  const K_SETTINGS = 'settings';
  const K_SNAPSHOTS = 'snapshots';
  const K_STATUS = 'status';
  const K_SECRETS = 'secrets';
  const K_SESSION_KEY = 'f2a.sessionKey';
  const K_SESSION_AT = 'f2a.unlockedAt';

  const DEFAULTS = () => ({
    schema: 2,
    encryptionEnabled: false,
    autoLockMinutes: 15,
    activeProvider: 'none',
    autofill: { enabled: true, showButton: true, requireUnlock: true },
    autoBackup: { enabled: false, intervalHours: 12, provider: '', minIntervalMin: 30 },
    localSnapshot: { enabled: true, intervalHours: 6, keep: 10 },
    fileExport: { enabled: false, intervalDays: 7, keepLast: 5 },
    sync: { enabled: false, deviceId: '', autoPush: true, lastPushedAt: '', lastPulledAt: '' },
    providers: {
      folder: { path: '2FA-Helper/2fa-helper-backup.json' },
      s3: { endpoint: '', region: 'us-east-1', bucket: '', accessKey: '', keyPath: '2fa-helper/backup.json' },
      webdav: { url: '', username: '', remotePath: '2fa-helper/backup.json' },
      gdrive: { clientId: '', clientSecret: '', filePath: '2fa-helper-backup.json', fileId: '' },
      dropbox: { appKey: '', filePath: '/2FA-Helper/backup.json' },
      onedrive: { clientId: '', tenant: 'common', filePath: '2fa-helper-backup.json' },
    },
  });

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function mergeDeep(base, patch) {
    const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    for (const [k, v] of Object.entries(patch || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
        out[k] = mergeDeep(base[k] || {}, v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  /* ---------------- generic storage helpers ---------------- */
  async function getRaw(key, fallback) {
    const res = await api.storage.local.get(key);
    return res && res[key] !== undefined ? res[key] : fallback;
  }
  async function setRaw(key, value) {
    await api.storage.local.set({ [key]: value });
  }

  async function getSettings() {
    return mergeDeep(DEFAULTS(), (await getRaw(K_SETTINGS, {})) || {});
  }

  async function setSettings(patch) {
    const next = mergeDeep(await getSettings(), patch);
    await setRaw(K_SETTINGS, next);
    return next;
  }

  const DEFAULT_SECRETS = () => ({ webdavPassword: '', gdriveSecret: '', s3Secret: '', tokens: {}, syncKey: '' });

  async function getSecrets() {
    return mergeDeep(DEFAULT_SECRETS(), (await getRaw(K_SECRETS, {})) || {});
  }
  async function setSecrets(patch) {
    const next = mergeDeep(await getSecrets(), patch);
    await setRaw(K_SECRETS, next);
    return next;
  }

  const DEFAULT_STATUS = () => ({
    lastLocalSaveAt: null,
    lastBackupAt: null,
    lastBackupProvider: '',
    lastBackupOk: null,
    lastError: '',
    lastRestoreAt: null,
    syncLastPushAt: '',
    syncLastPullAt: '',
    syncRemoteAt: '',
  });

  async function getStatus() {
    return mergeDeep(DEFAULT_STATUS(), (await getRaw(K_STATUS, {})) || {});
  }
  async function setStatus(patch) {
    const next = mergeDeep(await getStatus(), patch);
    await setRaw(K_STATUS, next);
    return next;
  }

  /* ---------------- entries ---------------- */
  function cleanHost(u) {
    return String(u || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
  }

  function normalizePasskey(e, now) {
    const pk = e.passkey || e;
    return {
      rpId: cleanHost(pk.rpId || e.issuer || ''),
      rpName: String(pk.rpName || e.issuer || '').trim(),
      userName: String(pk.userName || e.account || '').trim(),
      userDisplayName: String(pk.userDisplayName || '').trim(),
      userHandle: String(pk.userHandle || ''),
      credentialId: String(pk.credentialId || ''),
      publicKey: String(pk.publicKey || ''),
      algorithm: Number(pk.algorithm || -7),
      signCount: Number(pk.signCount || 0) || 0,
      privateKeyJwk: String(pk.privateKeyJwk || ''),
      note: String(pk.note || e.note || ''),
      createdAt: pk.createdAt || e.createdAt || now,
    };
  }

  function normalizeEntry(e) {
    const now = F2A.nowIso();
    const kind = (e.kind === 'passkey' || (e.passkey && !e.secret)) ? 'passkey' : 'otp';
    const base = {
      id: e.id || F2A.uid(),
      kind,
      issuer: String(e.issuer || (e.passkey && (e.passkey.rpName || e.passkey.rpId)) || '').trim(),
      account: String(e.account || (e.passkey && e.passkey.userName) || '').trim(),
      urls: (Array.isArray(e.urls) ? e.urls : (e.urls ? [e.urls] : [])).map(cleanHost).filter(Boolean),
      note: String(e.note || ''),
      tags: Array.isArray(e.tags) ? e.tags.map(String) : [],
      createdAt: e.createdAt || now,
      updatedAt: now,
    };

    if (kind === 'passkey') {
      base.type = 'passkey';
      base.passkey = normalizePasskey(e, now);
      if (!base.urls.length && base.passkey.rpId) base.urls = [base.passkey.rpId];
      if (!base.issuer) base.issuer = base.passkey.rpName || base.passkey.rpId;
      if (!base.account) base.account = base.passkey.userName;
      return base;
    }

    return Object.assign(base, {
      type: (e.type || 'totp').toLowerCase() === 'hotp' ? 'hotp' : 'totp',
      secret: String(e.secret || '').replace(/\s|-/g, '').toUpperCase(),
      digits: F2A.clamp(e.digits || 6, 6, 8),
      period: F2A.clamp(e.period || 30, 10, 300),
      algorithm: F2A.totp.normalizeAlgo(e.algorithm),
      counter: Number(e.counter || 0) || 0,
    });
  }

  function emptyData() { return { schema: 2, entries: [] }; }

  function dedupe(entries) {
    const seen = new Set();
    const out = [];
    for (const e of entries) {
      const key = e.kind === 'passkey'
        ? 'pk|' + ((e.passkey && e.passkey.credentialId) || (e.passkey && e.passkey.rpId) + '|' + (e.passkey && e.passkey.userName))
        : [e.issuer.toLowerCase(), e.account.toLowerCase(), e.secret].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
    return out;
  }

  /* ---------------- vault state ---------------- */
  async function readEnvelope() {
    return getRaw(K_VAULT, null);
  }

  async function getSessionKey() {
    try {
      const res = await api.storage.session.get([K_SESSION_KEY, K_SESSION_AT]);
      return { keyB64: res[K_SESSION_KEY] || null, at: res[K_SESSION_AT] || 0 };
    } catch (e) {
      return { keyB64: null, at: 0 };
    }
  }

  async function setSessionKey(keyB64) {
    try {
      await api.storage.session.set({ [K_SESSION_KEY]: keyB64, [K_SESSION_AT]: Date.now() });
    } catch (e) { /* storage.session unavailable → memory only */ }
  }

  async function clearSessionKey() {
    try { await api.storage.session.remove([K_SESSION_KEY, K_SESSION_AT]); } catch (e) { /* noop */ }
  }

  async function touch() {
    try { await api.storage.session.set({ [K_SESSION_AT]: Date.now() }); } catch (e) { /* noop */ }
  }

  async function checkAutoLock() {
    const settings = await getSettings();
    if (!settings.encryptionEnabled) return { locked: false, reason: 'no-encryption' };
    const { keyB64, at } = await getSessionKey();
    if (!keyB64) return { locked: true, reason: 'no-key' };
    const limit = Math.max(1, Number(settings.autoLockMinutes) || 15) * 60000;
    if (Date.now() - Number(at || 0) > limit) {
      await clearSessionKey();
      return { locked: true, reason: 'timeout' };
    }
    return { locked: false };
  }

  /**
   * @returns {{locked:boolean, encryptionEnabled:boolean, data?:object}}
   */
  async function state() {
    const settings = await getSettings();
    const env = await readEnvelope();
    if (!env) return { locked: false, encryptionEnabled: !!settings.encryptionEnabled, data: emptyData(), empty: true };
    if (!env.encrypted) return { locked: false, encryptionEnabled: false, data: env.data || emptyData() };
    const lock = await checkAutoLock();
    if (lock.locked) return { locked: true, encryptionEnabled: true };
    const { keyB64 } = await getSessionKey();
    try {
      const data = await C.openWithKey(env, keyB64);
      return { locked: false, encryptionEnabled: true, data };
    } catch (e) {
      await clearSessionKey();
      return { locked: true, encryptionEnabled: true, error: '会话密钥失效，请重新解锁' };
    }
  }

  async function unlock(password) {
    const env = await readEnvelope();
    if (!env) {
      // first run: create plaintext vault (or encrypted when a password is supplied)
      const sealed = await C.seal(emptyData(), password ? { password } : {});
      await setRaw(K_VAULT, sealed);
      if (password) await setSessionKey((await C.open(sealed, password)).keyB64);
      await setSettings({ encryptionEnabled: !!password });
      return { ok: true, data: emptyData() };
    }
    const opened = await C.open(env, password);
    if (opened.keyB64) await setSessionKey(opened.keyB64);
    await touch();
    return { ok: true, data: opened.data };
  }

  async function lock() {
    await clearSessionKey();
    return { ok: true };
  }

  async function requireData() {
    const s = await state();
    if (s.locked) {
      const err = new Error('LOCKED');
      err.code = 'LOCKED';
      throw err;
    }
    return s;
  }

  async function saveData(data, password) {
    const settings = await getSettings();
    const env = await readEnvelope();
    const encrypted = !!settings.encryptionEnabled;

    if (!encrypted) {
      const sealed = await C.seal(data, {});
      await setRaw(K_VAULT, sealed);
      return sealed;
    }

    // encrypted: reuse existing kdf params + cached raw key
    const { keyB64 } = await getSessionKey();
    if (!keyB64) { const err = new Error('LOCKED'); err.code = 'LOCKED'; throw err; }
    if (!env || !env.encrypted) {
      const sealed = await C.seal(data, { password: password || '' });
      await setRaw(K_VAULT, sealed);
      return sealed;
    }
    const key = await C.importKey(keyB64);
    const { iv, ct } = await C.encrypt(key, data);
    const sealed = Object.assign({}, env, {
      createdAt: F2A.nowIso(),
      cipher: { algo: 'AES-GCM-256', iv },
      payload: ct,
      meta: { entryCount: (data.entries || []).length },
    });
    await setRaw(K_VAULT, sealed);
    await touch();
    return sealed;
  }

  /* ---------------- entry CRUD ---------------- */
  async function upsertEntry(entry) {
    const s = await requireData();
    const data = s.data || emptyData();
    const list = Array.isArray(data.entries) ? data.entries.slice() : [];
    const norm = normalizeEntry(entry);
    const idx = list.findIndex((e) => e.id === norm.id);
    if (idx === -1) {
      list.push(norm);
    } else {
      norm.createdAt = list[idx].createdAt || norm.createdAt;
      list[idx] = norm;
    }
    data.entries = dedupe(list).sort((a, b) => (a.issuer + a.account).localeCompare(b.issuer + b.account, 'zh-Hans-CN'));
    await saveData(data);
    return norm;
  }

  async function deleteEntry(id) {
    const s = await requireData();
    const data = s.data || emptyData();
    data.entries = (data.entries || []).filter((e) => e.id !== id);
    await saveData(data);
    return true;
  }

  async function importEntries(entries, { mode = 'merge' } = {}) {
    const s = await requireData();
    const data = s.data || emptyData();
    const incoming = entries.map(normalizeEntry);
    const list = mode === 'replace' ? incoming : (data.entries || []).concat(incoming);
    data.entries = dedupe(list).sort((a, b) => (a.issuer + a.account).localeCompare(b.issuer + b.account, 'zh-Hans-CN'));
    await saveData(data);
    return { added: data.entries.length - (mode === 'replace' ? 0 : (s.data.entries || []).length), total: data.entries.length };
  }

  /* ---------------- encryption lifecycle ---------------- */
  async function setMasterPassword(password, currentPassword) {
    const settings = await getSettings();
    let data;
    if (settings.encryptionEnabled) {
      const opened = await C.open(await readEnvelope(), currentPassword);
      data = opened.data;
    } else {
      const env = await readEnvelope();
      data = env ? (env.data || emptyData()) : emptyData();
    }
    const sealed = await C.seal(data, { password });
    await setRaw(K_VAULT, sealed);
    await setSettings({ encryptionEnabled: true });
    const opened = await C.open(sealed, password);
    await setSessionKey(opened.keyB64);
    return { ok: true };
  }

  async function removeMasterPassword(currentPassword) {
    const opened = await C.open(await readEnvelope(), currentPassword);
    const sealed = await C.seal(opened.data, {});
    await setRaw(K_VAULT, sealed);
    await setSettings({ encryptionEnabled: false });
    await clearSessionKey();
    return { ok: true };
  }

  /* ---------------- snapshots ---------------- */
  async function listSnapshots() {
    const list = await getRaw(K_SNAPSHOTS, []);
    return Array.isArray(list) ? list : [];
  }

  async function addSnapshot(envelope, keep = 10) {
    const list = await listSnapshots();
    const json = JSON.stringify(envelope);
    // skip if identical to the newest snapshot
    if (list.length && JSON.stringify(list[0].envelope) === json) return { skipped: true, count: list.length };
    list.unshift({ ts: F2A.nowIso(), size: json.length, envelope });
    const trimmed = list.slice(0, Math.max(1, keep));
    await setRaw(K_SNAPSHOTS, trimmed);
    await setStatus({ lastLocalSaveAt: F2A.nowIso() });
    return { skipped: false, count: trimmed.length };
  }

  async function deleteSnapshot(ts) {
    const list = (await listSnapshots()).filter((s) => s.ts !== ts);
    await setRaw(K_SNAPSHOTS, list);
    return list;
  }

  Object.assign(F2A, {
    vault: {
      DEFAULTS, K_VAULT, K_SETTINGS, K_STATUS, K_SECRETS, K_SNAPSHOTS,
      clone, mergeDeep, emptyData, normalizeEntry, normalizePasskey, dedupe,
      getSettings, setSettings, getSecrets, setSecrets, getStatus, setStatus,
      readEnvelope, state, unlock, lock, requireData, saveData, touch, checkAutoLock,
      upsertEntry, deleteEntry, importEntries,
      setMasterPassword, removeMasterPassword,
      listSnapshots, addSnapshot, deleteSnapshot,
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
