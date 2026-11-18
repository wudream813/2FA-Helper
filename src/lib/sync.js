/* 2FA Helper — chrome.storage.sync end-to-end encrypted sync.
 *
 * Design notes (iCloud-Keychain style):
 *  - The payload is encrypted with a random 256-bit *sync key* that never leaves
 *    the devices; the browser's sync service only stores an AES-GCM ciphertext.
 *  - Devices pair by typing/scanning a recovery code (Base32, shown as a QR).
 *  - storage.sync limits are per-item (8 KB) and total (100 KB), so the record is
 *    split into ~6 KB chunks; the meta item is written last and acts as the commit.
 */
(function (root) {
  'use strict';
  const F2A = (root.F2A = root.F2A || {});
  const api = F2A.api;

  const PREFIX = 'f2a.sync.';
  const META_KEY = PREFIX + 'meta';
  const CHUNK_PREFIX = PREFIX + 'c';
  const CHUNK_SIZE = 6000;
  const MAX_TOTAL = 88000;          // keeps us below QUOTA_BYTES (102400)
  const ITEM_LIMIT = 8192;
  const ALARM = 'f2a.sync';

  function area() {
    const a = api.storage && api.storage.sync;
    if (!a) {
      const err = new Error('当前浏览器不支持 storage.sync 同步（可能处于隐私窗口或企业策略禁用）');
      err.code = 'NO_SYNC';
      throw err;
    }
    return a;
  }

  const available = () => !!(api.storage && api.storage.sync);

  /* ---------------- sync key ---------------- */
  function newKey() {
    return F2A.b32encode(F2A.randomBytes(32));
  }

  function formatCode(b32) {
    const clean = String(b32 || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
    return clean.replace(/(.{4})(?=.)/g, '$1-');
  }

  function parseCode(text) {
    let clean = String(text || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
    if (clean.length < 26 || clean.length > 64) throw new Error('配对码长度不正确（应为 52 位 Base32）');
    return clean;
  }

  async function importKey(b32) {
    const raw = F2A.b32decode(parseCode(b32));
    if (raw.length < 16) throw new Error('配对码无效');
    return root.crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function getKey() {
    const s = await F2A.vault.getSecrets();
    return s.syncKey || '';
  }

  async function setKey(b32) {
    await F2A.vault.setSecrets({ syncKey: parseCode(b32) });
    return parseCode(b32);
  }

  async function clearKey() {
    await F2A.vault.setSecrets({ syncKey: '' });
  }

  /* ---------------- crypto ---------------- */
  async function sha256B64(str) {
    const digest = await root.crypto.subtle.digest('SHA-256', F2A.utf8Encode(str));
    return F2A.bytesToB64(new Uint8Array(digest));
  }

  async function seal(payload, keyB32) {
    const key = await importKey(keyB32);
    const iv = F2A.randomBytes(12);
    const plain = JSON.stringify(payload);
    const ct = new Uint8Array(await root.crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, F2A.utf8Encode(plain)));
    const ctB64 = F2A.bytesToB64(ct);
    return {
      v: 1,
      alg: 'A256GCM',
      iv: F2A.bytesToB64(iv),
      ct: ctB64,
      sha: await sha256B64(ctB64),
      // metadata the UI may show without decrypting (never contains secrets)
      entryCount: payload.entryCount || 0,
      updatedAt: payload.updatedAt || F2A.nowIso(),
    };
  }

  async function open(record, keyB32) {
    if (!record || record.alg !== 'A256GCM') throw new Error('云端记录格式无法识别');
    const ctB64 = record.ct || '';
    if (record.sha && (await sha256B64(ctB64)) !== record.sha) {
      throw new Error('云端数据校验失败（分片不完整），请重试或重新推送');
    }
    const key = await importKey(keyB32);
    let plain;
    try {
      const pt = await root.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: F2A.b64ToBytes(record.iv), tagLength: 128 },
        key,
        F2A.b64ToBytes(ctB64)
      );
      plain = F2A.utf8Decode(new Uint8Array(pt));
    } catch (e) {
      throw new Error('解密失败：配对码不匹配，或云端数据被其他设备覆盖');
    }
    return JSON.parse(plain);
  }

  /* ---------------- chunking ---------------- */
  function chunkify(str) {
    const out = [];
    for (let i = 0; i < str.length; i += CHUNK_SIZE) out.push(str.slice(i, i + CHUNK_SIZE));
    return out;
  }

  function byteLen(str) { return F2A.utf8Encode(str).length; }

  /* ---------------- push / pull ---------------- */
  async function buildPayload() {
    const env = await F2A.vault.readEnvelope();
    if (!env) throw new Error('本地还没有数据可同步');
    const settings = await F2A.vault.getSettings();
    return {
      v: 1,
      schema: 2,
      updatedAt: env.createdAt || F2A.nowIso(),
      entryCount: (env.meta && env.meta.entryCount) || 0,
      deviceId: settings.sync.deviceId,
      envelope: env,
    };
  }

  async function push(opts = {}) {
    const s = area();
    const key = await getKey();
    if (!key) throw new Error('尚未启用同步或缺少配对码');
    const payload = await buildPayload();

    // nothing new? leave the cloud untouched (also prevents two devices from
    // pushing each other's content back and forth)
    if (!opts.force) {
      const remoteMeta = await readMeta().catch(() => null);
      if (remoteMeta && remoteMeta.updatedAt === payload.updatedAt && remoteMeta.entryCount === payload.entryCount) {
        return { ok: true, skipped: true, reason: 'unchanged', chunks: remoteMeta.chunks, entryCount: remoteMeta.entryCount };
      }
    }
    const record = await seal(payload, key);
    const json = JSON.stringify(record);

    if (byteLen(json) > MAX_TOTAL) {
      throw new Error(`数据过大（${Math.round(byteLen(json) / 1024)} KB），超出 storage.sync 约 90 KB 配额。请减少条目备注或关闭同步。`);
    }

    const chunks = chunkify(json);
    const items = {};
    chunks.forEach((c, i) => { items[CHUNK_PREFIX + i] = c; });

    const meta = {
      v: 1,
      chunks: chunks.length,
      size: byteLen(json),
      iv: record.iv,
      sha: record.sha,
      entryCount: payload.entryCount,
      updatedAt: payload.updatedAt,
      pushedAt: F2A.nowIso(),
      deviceId: payload.deviceId,
    };

    if (byteLen(JSON.stringify(meta)) > ITEM_LIMIT) throw new Error('同步元数据过大'); // defensive; never happens

    await s.set(items);
    await s.set({ [META_KEY]: meta });

    // drop chunks left over from a previous, larger push
    try {
      const all = await s.get(null);
      const stale = Object.keys(all).filter((k) => k.startsWith(CHUNK_PREFIX) && Number(k.slice(CHUNK_PREFIX.length)) >= chunks.length);
      if (stale.length) await s.remove(stale);
    } catch (e) { /* non fatal */ }

    await F2A.vault.setSettings({ sync: { lastPushedAt: meta.pushedAt } });
    await F2A.vault.setStatus({ syncLastPushAt: meta.pushedAt, syncRemoteAt: meta.updatedAt });
    return { ok: true, chunks: chunks.length, size: meta.size, entryCount: meta.entryCount };
  }

  async function readMeta() {
    const s = area();
    const res = await s.get(META_KEY);
    return res[META_KEY] || null;
  }

  async function readRemote() {
    const s = area();
    const meta = await readMeta();
    if (!meta) return null;
    const keys = [];
    for (let i = 0; i < meta.chunks; i++) keys.push(CHUNK_PREFIX + i);
    const res = await s.get(keys);
    const missing = keys.filter((k) => typeof res[k] !== 'string');
    if (missing.length) throw new Error(`云端分片缺失（${missing.length}/${meta.chunks}），请从有完整数据的设备重新推送`);
    const json = keys.map((k) => res[k]).join('');
    let record;
    try {
      record = JSON.parse(json);
    } catch (e) {
      throw new Error('云端数据校验失败（分片不完整或被破坏），请在数据完整的设备上重新推送');
    }
    return { meta, record };
  }

  /** Cheap check: read only the meta item. */
  async function check() {
    if (!available()) return { available: false, enabled: false };
    const settings = await F2A.vault.getSettings();
    const env = await F2A.vault.readEnvelope();
    const meta = await readMeta().catch(() => null);
    const localUpdatedAt = (env && env.createdAt) || '';
    const remoteUpdatedAt = (meta && meta.updatedAt) || '';
    const localMs = localUpdatedAt ? new Date(localUpdatedAt).getTime() : 0;
    const remoteMs = remoteUpdatedAt ? new Date(remoteUpdatedAt).getTime() : 0;
    const lastApplied = (await F2A.vault.getStatus()).syncLastPullAt || '';
    return {
      available: true,
      enabled: !!settings.sync.enabled,
      hasKey: !!(await getKey()),
      hasRemote: !!meta,
      remoteUpdatedAt,
      remoteEntryCount: (meta && meta.entryCount) || 0,
      remoteDeviceId: (meta && meta.deviceId) || '',
      pushedAt: (meta && meta.pushedAt) || '',
      localUpdatedAt,
      remoteIsNewer: !!(meta && remoteMs > localMs + 500 && (!lastApplied || remoteUpdatedAt !== lastApplied)),
      lastPushedAt: settings.sync.lastPushedAt || '',
      lastPulledAt: lastApplied,
    };
  }

  /** Fetch + decrypt, but do not touch local storage. */
  async function fetchRemote() {
    const key = await getKey();
    if (!key) throw new Error('本机没有配对码，无法读取云端数据');
    const remote = await readRemote();
    if (!remote) return null;
    const payload = await open(remote.record, key);
    if (!payload || !payload.envelope) throw new Error('云端数据缺少保管库内容');
    await F2A.backup.inspect(JSON.stringify(payload.envelope)); // 结构校验（不decrypt）
    return { payload, meta: remote.meta, envelope: payload.envelope };
  }

  let suppressUntil = 0;
  const isSuppressed = () => Date.now() < suppressUntil;

  /** Apply the remote vault (requires the master password when it is encrypted). */
  async function pull(password) {
    const remote = await fetchRemote();
    if (!remote) throw new Error('云端还没有数据');
    const info = await F2A.backup.inspect(JSON.stringify(remote.envelope), password);
    if (info.needsPassword) return { ok: false, needsPassword: true, meta: remote.meta };
    suppressUntil = Date.now() + 30000;   // don't echo the pulled change straight back
    const res = await F2A.backup.applyRestore(remote.envelope, password || '');
    await F2A.vault.setStatus({ syncLastPullAt: remote.meta.updatedAt, syncRemoteAt: remote.meta.updatedAt });
    await F2A.vault.setSettings({ sync: { lastPulledAt: F2A.nowIso() } });
    return { ok: true, entries: res.entries, meta: remote.meta };
  }

  /* ---------------- lifecycle ---------------- */
  async function enable({ setKeyTo } = {}) {
    area();
    const settings = await F2A.vault.getSettings();
    if (!settings.sync.deviceId) {
      await F2A.vault.setSettings({ sync: { deviceId: F2A.uid() } });
    }
    const key = setKeyTo ? await setKey(setKeyTo) : await setKey(newKey());
    await F2A.vault.setSettings({ sync: { enabled: true } });
    const pushed = await push();
    await schedule();
    return { ok: true, code: formatCode(key), raw: key, pushed };
  }

  /** Join an existing sync group with a recovery code from another device. */
  async function join(code) {
    area();
    const key = parseCode(code);
    await setKey(key);
    await F2A.vault.setSettings({ sync: { enabled: true } });
    await schedule();
    let remote;
    try {
      remote = await fetchRemote();
    } catch (e) {
      // wrong / stale code: leave the device as it was
      await clearKey();
      await F2A.vault.setSettings({ sync: { enabled: false } });
      await schedule();
      throw new Error('配对失败：' + e.message);
    }
    return {
      ok: true,
      code: formatCode(key),
      hasRemote: !!remote,
      remoteEntryCount: remote ? (remote.envelope.meta && remote.envelope.meta.entryCount) || 0 : 0,
      remoteUpdatedAt: remote ? remote.meta.updatedAt : '',
    };
  }

  async function disable({ wipeRemote = true } = {}) {
    const s = area();
    if (wipeRemote) {
      try {
        const all = await s.get(null);
        const keys = Object.keys(all).filter((k) => k.startsWith(PREFIX));
        if (keys.length) await s.remove(keys);
      } catch (e) { /* ignore */ }
    }
    await clearKey();
    await F2A.vault.setSettings({ sync: { enabled: false, lastPushedAt: '', lastPulledAt: '' } });
    await F2A.vault.setStatus({ syncLastPushAt: '', syncLastPullAt: '', syncRemoteAt: '' });
    await schedule();
    return { ok: true };
  }

  async function schedule() {
    try {
      const settings = await F2A.vault.getSettings();
      const existing = await api.alarms.get(ALARM);
      if (existing) await api.alarms.clear(ALARM);
      if (settings.sync.enabled) {
        api.alarms.create(ALARM, { periodInMinutes: 60, delayInMinutes: 5 });
      }
    } catch (e) { /* alarms unavailable */ }
  }

  Object.assign(F2A, {
    sync: {
      ALARM, PREFIX, META_KEY, CHUNK_PREFIX, CHUNK_SIZE, MAX_TOTAL,
      available, newKey, formatCode, parseCode, getKey, setKey,
      push, pull, check, fetchRemote, readMeta, readRemote, isSuppressed,
      enable, join, disable, schedule,
      _seal: seal, _open: open, _chunkify: chunkify,
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
