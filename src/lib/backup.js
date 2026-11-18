/* 2FA Helper — backup orchestration: local snapshots, file export, cloud upload */
(function (root) {
  'use strict';
  const F2A = (root.F2A = root.F2A || {});
  const api = F2A.api;

  const ALARM_SNAPSHOT = 'f2a.snapshot';
  const ALARM_BACKUP = 'f2a.backup';
  const ALARM_EXPORT = 'f2a.export';

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  /** Serialize the current stored vault into the portable backup format. */
  async function build() {
    const env = await F2A.vault.readEnvelope();
    if (!env) throw new Error('本地尚无数据，先添加一个账户吧');
    const payload = Object.assign({}, env, {
      exportedAt: F2A.nowIso(),
      generator: '2FA Helper',
      generatorVersion: root.__F2A_VERSION__ || '1.0.0',
    });
    const json = JSON.stringify(payload, null, 2);
    return { json, envelope: payload, size: json.length, bytes: new Blob([json]).size };
  }

  /* ---------------- local snapshots ---------------- */
  async function snapshot(reason = 'auto') {
    const settings = await F2A.vault.getSettings();
    if (reason === 'auto' && !settings.localSnapshot.enabled) return { skipped: true, reason: 'disabled' };
    const env = await F2A.vault.readEnvelope();
    if (!env) return { skipped: true, reason: 'empty' };
    const res = await F2A.vault.addSnapshot(env, settings.localSnapshot.keep || 10);
    return Object.assign({ ok: true }, res);
  }

  async function pruneSnapshots() {
    const settings = await F2A.vault.getSettings();
    const list = await F2A.vault.listSnapshots();
    const keep = Math.max(1, Number(settings.localSnapshot.keep) || 10);
    if (list.length > keep) {
      await api.storage.local.set({ snapshots: list.slice(0, keep) });
    }
  }

  /* ---------------- download to disk ---------------- */
  function downloadViaPage(json, filename) {
    // only works in a document context
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  async function exportFile(opts = {}) {
    const { json } = await build();
    const filename = opts.filename || `2fa-helper-backup-${stamp()}.json`;
    if (typeof document !== 'undefined' && document.createElement) {
      downloadViaPage(json, filename);
      await F2A.vault.setStatus({ lastLocalSaveAt: F2A.nowIso() });
      return { ok: true, filename, method: 'page' };
    }
    // background context
    if (!api.downloads) throw new Error('当前浏览器不支持 downloads API');
    let url;
    let blobUrl = null;
    if (typeof URL.createObjectURL === 'function') {
      // Firefox event pages still have a document; blob: URLs work there
      blobUrl = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      url = blobUrl;
    } else {
      // Chromium MV3 service worker: no createObjectURL, but data: URLs are accepted
      url = 'data:application/json;charset=utf-8;base64,' + F2A.bytesToB64(F2A.utf8Encode(json));
    }
    try {
      const id = await api.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
      await F2A.vault.setStatus({ lastLocalSaveAt: F2A.nowIso() });
      return { ok: true, filename, downloadId: id, method: 'background' };
    } finally {
      if (blobUrl) setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    }
  }

  /* ---------------- cloud ---------------- */
  async function upload(providerId) {
    const settings = await F2A.vault.getSettings();
    const id = providerId || settings.autoBackup.provider || settings.activeProvider;
    if (!id || id === 'none') throw new Error('还没有选择备份渠道');
    const { json, bytes } = await build();
    let res;
    try {
      res = await F2A.providers.upload(id, json);
    } catch (e) {
      await F2A.vault.setStatus({
        lastBackupProvider: id,
        lastBackupOk: false,
        lastError: String(e.message || e),
      });
      throw e;
    }
    await F2A.vault.setStatus({
      lastBackupAt: F2A.nowIso(),
      lastBackupProvider: id,
      lastBackupOk: true,
      lastError: '',
    });
    return Object.assign({ ok: true, bytes, provider: id }, res);
  }

  async function runScheduledBackup() {
    const settings = await F2A.vault.getSettings();
    if (!settings.autoBackup.enabled) return { skipped: true, reason: 'disabled' };
    const provider = settings.autoBackup.provider || settings.activeProvider;
    if (!provider || provider === 'none') return { skipped: true, reason: 'no-provider' };
    const status = await F2A.vault.getStatus();
    const minGap = Math.max(1, Number(settings.autoBackup.minIntervalMin) || 30) * 60000;
    if (status.lastBackupAt && Date.now() - new Date(status.lastBackupAt).getTime() < minGap) {
      return { skipped: true, reason: 'too-soon' };
    }
    try {
      const res = await upload(provider);
      return res;
    } catch (e) {
      await F2A.vault.setStatus({ lastBackupProvider: provider, lastBackupOk: false, lastError: String(e.message || e) });
      throw e;
    }
  }

  /**
   * Parse + validate a backup file. Does NOT touch storage.
   * @returns {{envelope:object, encrypted:boolean, data?:object, keyB64?:string, meta:object}}
   */
  async function inspect(jsonText, password) {
    let env;
    try { env = JSON.parse(jsonText); } catch (e) { throw new Error('文件不是有效的 JSON'); }
    if (!env || env.format !== F2A.vaultCrypto.FORMAT) throw new Error('这不是 2FA Helper 的备份文件');
    if (!env.encrypted) return { envelope: env, encrypted: false, data: env.data || {}, meta: env.meta || {} };
    if (!password) return { envelope: env, encrypted: true, meta: env.meta || {}, needsPassword: true };
    const opened = await F2A.vaultCrypto.open(env, password);
    return { envelope: env, encrypted: true, data: opened.data, keyB64: opened.keyB64, meta: env.meta || {} };
  }

  async function applyRestore(envelope, password) {
    const opened = await F2A.vaultCrypto.open(envelope, password);
    await api.storage.local.set({ vault: envelope });
    await F2A.vault.setSettings({ encryptionEnabled: !!envelope.encrypted });
    if (opened.keyB64) {
      try { await api.storage.session.set({ 'f2a.sessionKey': opened.keyB64, 'f2a.unlockedAt': Date.now() }); } catch (e) { /* noop */ }
    }
    await F2A.vault.setStatus({ lastRestoreAt: F2A.nowIso() });
    await snapshot('restore');
    return { ok: true, entries: (opened.data.entries || []).length };
  }

  async function restoreFromProvider(providerId, password) {
    const text = await F2A.providers.download(providerId);
    const info = await inspect(text, password);
    if (info.needsPassword) return Object.assign({ ok: false, needsPassword: true }, info);
    const res = await applyRestore(info.envelope, password);
    return Object.assign({ ok: true }, res);
  }

  /* ---------------- alarms / scheduling ---------------- */
  async function scheduleAll() {
    const settings = await F2A.vault.getSettings();
    const all = await api.alarms.getAll();
    for (const a of all) {
      if ([ALARM_SNAPSHOT, ALARM_BACKUP, ALARM_EXPORT].includes(a.name)) await api.alarms.clear(a.name);
    }
    const mk = (name, hours, minutes) => {
      const period = Math.max(1, Math.round((hours || 0) * 60 + (minutes || 0)));
      api.alarms.create(name, { periodInMinutes: period, delayInMinutes: period });
    };
    if (settings.localSnapshot.enabled) mk(ALARM_SNAPSHOT, Number(settings.localSnapshot.intervalHours) || 6);
    if (settings.autoBackup.enabled && settings.autoBackup.provider && settings.autoBackup.provider !== 'none') {
      mk(ALARM_BACKUP, Number(settings.autoBackup.intervalHours) || 12);
    }
    if (settings.fileExport.enabled) {
      api.alarms.create(ALARM_EXPORT, {
        periodInMinutes: Math.max(1, Math.round((Number(settings.fileExport.intervalDays) || 7) * 1440)),
        delayInMinutes: Math.max(1, Math.round((Number(settings.fileExport.intervalDays) || 7) * 1440)),
      });
    }
    return { ok: true };
  }

  Object.assign(F2A, {
    backup: {
      ALARM_SNAPSHOT, ALARM_BACKUP, ALARM_EXPORT,
      build, snapshot, pruneSnapshots, exportFile, upload, runScheduledBackup,
      inspect, applyRestore, restoreFromProvider, scheduleAll, downloadViaPage,
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
