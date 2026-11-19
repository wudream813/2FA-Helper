/* 2FA Helper — options page controller (all privileged work is delegated to the background) */
(function () {
  'use strict';
  const F2A = globalThis.F2A;
  const api = F2A.api;
  const $ = (id) => document.getElementById(id);

  let settings = null;
  let secretsInfo = null;

  async function send(type, payload = {}) {
    let res;
    try { res = await api.runtime.sendMessage(Object.assign({ type }, payload)); }
    catch (e) { throw new Error('后台连接失败：' + (e.message || e)); }
    if (!res) throw new Error('后台无响应');
    if (!res.ok) { const e = new Error(res.error || '未知错误'); e.code = res.code; throw e; }
    return res.data;
  }

  let toastTimer;
  function toast(msg, bad) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('bad', !!bad);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  /* ================= providers ================= */
  const PROVIDERS = [
    {
      id: 'none', label: '不启用', kind: 'none', cost: 'free',
      fields: [],
    },
    {
      id: 'folder', label: '文件夹同步', kind: 'local', cost: 'free',
      connectLabel: '检查路径',
      fields: [
        { key: 'path', label: '写入「下载」目录下的相对路径', placeholder: '2FA-Helper/2fa-helper-backup.json', wide: true },
      ],
    },
    {
      id: 's3', label: '对象存储', kind: 'keys', cost: 'free', presets: 's3',
      connectLabel: '测试连接',
      fields: [
        { key: 'endpoint', label: 'Endpoint', placeholder: 'https://s3.us-east-1.amazonaws.com', wide: true },
        { key: 'region', label: 'Region', placeholder: 'us-east-1' },
        { key: 'bucket', label: 'Bucket', placeholder: 'my-backups' },
        { key: 'keyPath', label: '对象路径', placeholder: '2fa-helper/backup.json', wide: true },
        { key: 'accessKey', label: 'AccessKey ID', placeholder: 'AKIA…' },
        { key: 'secretKey', label: 'SecretKey', type: 'password', secret: 's3Secret', placeholder: '••••••••' },
      ],
    },
    {
      id: 'webdav', label: 'WebDAV 网盘', kind: 'basic', cost: 'free', presets: 'webdav',
      fields: [
        { key: 'url', label: 'WebDAV 地址', placeholder: 'https://dav.jianguoyun.com/dav/2fa-helper/backup.json', wide: true },
        { key: 'username', label: '用户名 / 邮箱', placeholder: 'you@example.com' },
        { key: 'password', label: '应用密码', type: 'password', secret: 'webdavPassword', placeholder: '••••••••' },
        { key: 'remotePath', label: '远端路径（可选）', placeholder: '2fa-helper/backup.json' },
      ],
      connectLabel: '测试连接',
    },
    {
      id: 'gdrive', label: 'Google Drive', kind: 'oauth', cost: 'oauth',
      fields: [
        { key: 'clientId', label: 'Client ID', placeholder: 'xxxx.apps.googleusercontent.com', wide: true },
        { key: 'clientSecret', label: 'Client Secret', type: 'password', secret: 'gdriveSecret', placeholder: '可留空（PKCE）' },
        { key: 'filePath', label: '云端文件名', placeholder: '2fa-helper-backup.json' },
      ],
      connectLabel: '连接 Google 账号',
    },
    {
      id: 'dropbox', label: 'Dropbox', kind: 'oauth', cost: 'oauth',
      fields: [
        { key: 'appKey', label: 'App key', placeholder: 'abcd1234efgh', wide: true },
        { key: 'filePath', label: '云端路径', placeholder: '/2FA-Helper/backup.json' },
      ],
      connectLabel: '连接 Dropbox',
    },
    {
      id: 'onedrive', label: 'OneDrive', kind: 'oauth', cost: 'builtin',
      fields: [
        { key: 'clientId', label: '应用程序（客户端）ID', placeholder: '00000000-0000-0000-0000-000000000000', wide: true, builtin: true, advanced: true },
        { key: 'tenant', label: '租户', placeholder: 'common' },
        { key: 'filePath', label: '云端文件名', placeholder: '2fa-helper-backup.json' },
      ],
      connectLabel: '连接 OneDrive',
    },
  ];

  let redirectUrl = '';
  let activeTab = 'none';

  function providerSettings(id) {
    return (settings.providers && settings.providers[id]) || {};
  }

  function renderTabs() {
    const wrap = $('providerTabs');
    wrap.innerHTML = '';
    const current = settings.activeProvider || 'none';
    for (const p of PROVIDERS) {
      const b = document.createElement('button');
      b.className = 'provider-tab' + (p.id === activeTab ? ' active' : '');
      b.appendChild(document.createTextNode(p.label));
      if (p.id !== 'none') {
        const cost = document.createElement('span');
        cost.className = 'cost' + (p.cost === 'oauth' ? ' oauth' : p.cost === 'builtin' ? ' builtin' : '');
        cost.textContent = p.cost === 'oauth' ? '需注册' : p.cost === 'builtin' ? '已内置' : '免注册';
        b.appendChild(document.createTextNode(' '));
        b.appendChild(cost);
      }
      if (p.id === current) {
        const pin = document.createElement('span');
        pin.className = 'pin';
        pin.textContent = '默认';
        b.appendChild(document.createTextNode(' '));
        b.appendChild(pin);
      }
      b.addEventListener('click', () => { activeTab = p.id; renderTabs(); renderPanels(); });
      wrap.appendChild(b);
    }
    $('activeProviderBadge').textContent = '默认：' + (PROVIDERS.find((p) => p.id === current) || {}).label;
    $('activeProviderBadge').className = 'badge' + (current === 'none' ? ' off' : '');
  }

  function renderPanels() {
    const wrap = $('providerPanels');
    wrap.innerHTML = '';
    for (const p of PROVIDERS) {
      const panel = document.createElement('div');
      panel.className = 'panel' + (p.id === activeTab ? ' active' : '');

      const help = document.createElement('div');
      help.className = 'help';
      const tpl = $('tpl-help-' + p.id);
      if (tpl && tpl.content) help.appendChild(tpl.content.cloneNode(true));
      else help.textContent = p.label;
      panel.appendChild(help);

      if (p.presets) {
        const PRESETS = p.presets === 's3'
          ? (F2A.providers && F2A.providers.S3_PRESETS) || []
          : (F2A.providers && F2A.providers.WEBDAV_PRESETS) || [];
        if (PRESETS.length) {
          const row = document.createElement('div');
          row.className = 'preset-row';
          const label = document.createElement('label');
          label.textContent = '快速预设（一键填好地址）';
          const select = document.createElement('select');
          const blank = document.createElement('option');
          blank.value = '';
          blank.textContent = '— 选择服务商 —';
          select.appendChild(blank);
          for (const preset of PRESETS) {
            const opt = document.createElement('option');
            opt.value = preset.id;
            opt.textContent = preset.label;
            select.appendChild(opt);
          }
          const helpEl = document.createElement('div');
          helpEl.className = 'preset-help';
          select.addEventListener('change', async () => {
            const preset = PRESETS.find((x) => x.id === select.value);
            if (!preset) { helpEl.textContent = ''; return; }
            helpEl.textContent = preset.help || '';
            try {
              if (p.presets === 's3') {
                const endpointInput = row.parentElement.querySelector('input[placeholder^="https://s3."]');
                const regionInput = row.parentElement.querySelector('input[placeholder="us-east-1"]');
                if (endpointInput && preset.endpoint) endpointInput.value = preset.endpoint;
                if (regionInput && preset.region) regionInput.value = preset.region;
                await send('settings.set', { providers: { s3: { endpoint: preset.endpoint || '', region: preset.region || 'us-east-1' } } });
              } else {
                const urlInput = row.parentElement.querySelector('input[placeholder^="https://dav."]');
                if (urlInput && preset.template) urlInput.value = preset.template;
                if (preset.template) await send('settings.set', { providers: { webdav: { url: preset.template } } });
              }
              settings = await send('settings.get');
              toast('已填入预设，请补全账号信息');
            } catch (e) { toast(e.message, true); }
          });
          label.appendChild(select);
          row.append(label, helpEl);
          panel.appendChild(row);
        }
      }

      const builtinId = p.kind === 'oauth' && F2A.providers && F2A.providers.builtinClient
        ? F2A.providers.builtinClient(p.id) : '';
      if (builtinId) {
        const note = document.createElement('div');
        note.className = 'builtin-note';
        const strong = document.createElement('b');
        strong.textContent = '点一下就能连 —— 已内置客户端 ID，不用去任何地方注册。';
        const small = document.createElement('span');
        small.textContent = '直接点下面的「' + (p.connectLabel || '连接') + '」登录授权即可。如果你是开发者、想用自己的应用，把「客户端 ID」换成你自己的（下方蓝色回调地址要加到你自己的应用里）。';
        note.append(strong, small);
        panel.appendChild(note);
      }

      if (p.kind === 'oauth') {
        const box = document.createElement('div');
        box.className = 'redirect-box';
        const urlSpan = document.createElement('span');
        urlSpan.className = 'url';
        urlSpan.textContent = redirectUrl || '（无法获取回调地址）';
        box.appendChild(urlSpan);
        const copy = document.createElement('button');
        copy.className = 'btn ghost';
        copy.textContent = '复制';
        copy.addEventListener('click', async () => {
          await navigator.clipboard.writeText(redirectUrl);
          toast('回调地址已复制');
        });
        box.appendChild(copy);
        panel.appendChild(box);
      }

      if (p.fields.length) {
        const row = document.createElement('div');
        row.className = 'field-row';
        for (const f of p.fields) {
          const label = document.createElement('label');
          label.textContent = f.label;
          if (f.wide) label.style.flexBasis = '100%';
          const input = document.createElement('input');
          input.type = f.type || 'text';
          input.placeholder = f.placeholder || '';
          if (f.type === 'password' && f.secret && secretsInfo) {
            const has = f.secret === 'webdavPassword' ? secretsInfo.hasWebdavPassword
              : f.secret === 's3Secret' ? secretsInfo.hasS3Secret
                : secretsInfo.hasGdriveSecret;
            input.placeholder = has ? '已保存（留空则保持不变）' : (f.placeholder || '');
          }
          const stored = providerSettings(p.id)[f.key] || '';
          input.value = f.secret ? '' : (stored || (f.builtin ? F2A.providers.builtinClient(p.id) : ''));
          if (f.builtin && !stored && input.value) {
            input.dataset.builtin = '1';
            input.addEventListener('input', () => { delete input.dataset.builtin; });
            const reset = document.createElement('button');
            reset.className = 'btn ghost tiny';
            reset.type = 'button';
            reset.textContent = '用内置';
            reset.addEventListener('click', async () => {
              try {
                await send('settings.set', { providers: { [p.id]: { [f.key]: '' } } });
                settings = await send('settings.get');
                renderPanels();
                toast('已恢复为内置客户端 ID');
              } catch (e) { toast(e.message, true); }
            });
            label.appendChild(reset);
          }
          input.addEventListener('change', async () => {
            try {
              if (f.secret) {
                if (!input.value) return;
                await send('secrets.set', { [f.secret]: input.value });
                input.value = '';
                input.placeholder = '已保存（留空则保持不变）';
                secretsInfo = await send('secrets.get');
              } else {
                await send('settings.set', { providers: { [p.id]: { [f.key]: input.value.trim() } } });
                settings = await send('settings.get');
              }
              toast('已保存');
            } catch (e) { toast(e.message, true); }
          });
          label.appendChild(input);
          row.appendChild(label);
        }
        panel.appendChild(row);
      }

      const btnRow = document.createElement('div');
      btnRow.className = 'btn-row';

      const pin = document.createElement('button');
      pin.className = 'btn primary';
      pin.textContent = (settings.activeProvider === p.id) ? '已是默认渠道' : '设为默认渠道';
      pin.disabled = settings.activeProvider === p.id;
      pin.addEventListener('click', async () => {
        try {
          await send('settings.set', { activeProvider: p.id, autoBackup: { provider: p.id } });
          settings = await send('settings.get');
          renderTabs();
          renderPanels();
          refreshChips();
          toast('默认渠道已更新');
        } catch (e) { toast(e.message, true); }
      });
      btnRow.appendChild(pin);

      if (p.kind !== 'none') {
        const conn = document.createElement('button');
        conn.className = 'btn';
        conn.textContent = p.connectLabel;
        conn.addEventListener('click', async () => {
          conn.disabled = true;
          const old = conn.textContent;
          conn.textContent = p.kind === 'oauth' ? '等待浏览器授权…' : '连接中…';
          try {
            const res = await send('providers.connect', { provider: p.id });
            toast(res.message || '连接成功');
          } catch (e) {
            toast(e.message, true);
          } finally {
            conn.disabled = false;
            conn.textContent = old;
            secretsInfo = await send('secrets.get').catch(() => secretsInfo);
            renderPanels();
          }
        });
        btnRow.appendChild(conn);

        const test = document.createElement('button');
        test.className = 'btn ghost';
        test.textContent = '测试连接';
        test.addEventListener('click', async () => {
          test.disabled = true;
          try {
            const res = await send('providers.test', { provider: p.id });
            toast(res.message || '连接正常');
          } catch (e) { toast(e.message, true); }
          finally { test.disabled = false; }
        });
        btnRow.appendChild(test);

        if (p.kind === 'oauth') {
          const off = document.createElement('button');
          off.className = 'btn ghost';
          off.textContent = '断开授权';
          off.addEventListener('click', async () => {
            await send('providers.disconnect', { provider: p.id });
            toast('已断开');
          });
          btnRow.appendChild(off);
        }
      }

      panel.appendChild(btnRow);
      wrap.appendChild(panel);
    }
  }

  /* ================= crypto card ================= */
  function renderCrypto() {
    const on = !!settings.encryptionEnabled;
    $('cryptoOn').hidden = !on;
    $('cryptoOff').hidden = on;
    $('cryptBadge').textContent = on ? '已加密（AES-256-GCM）' : '未加密';
    $('cryptBadge').className = 'badge' + (on ? '' : ' off');
    $('autoLock').value = settings.autoLockMinutes;
    $('autoLock').disabled = !on;
  }

  $('enableCrypto').addEventListener('click', async () => {
    $('cryptoErr').textContent = '';
    const p1 = $('newPass').value;
    const p2 = $('newPass2').value;
    if (p1.length < 6) { $('cryptoErr').textContent = '主密码至少 6 位'; return; }
    if (p1 !== p2) { $('cryptoErr').textContent = '两次输入不一致'; return; }
    const btn = $('enableCrypto');
    btn.disabled = true; btn.textContent = '加密中…';
    try {
      await send('crypto.setPassword', { password: p1 });
      settings = await send('settings.get');
      $('newPass').value = ''; $('newPass2').value = '';
      renderCrypto(); refreshChips();
      toast('加密已开启，请牢记主密码');
    } catch (e) { $('cryptoErr').textContent = e.message; }
    finally { btn.disabled = false; btn.textContent = '开启加密'; }
  });

  $('changeCrypto').addEventListener('click', async () => {
    $('cryptoErr').textContent = '';
    const cur = $('curPass').value;
    const next = $('chgPass').value;
    if (!cur) { $('cryptoErr').textContent = '请输入当前主密码'; return; }
    try {
      if (next) {
        if (next.length < 6) throw new Error('新主密码至少 6 位');
        await send('crypto.setPassword', { password: next, currentPassword: cur });
        toast('主密码已更新');
      } else {
        await send('vault.unlock', { password: cur });
        toast('验证通过');
      }
      $('curPass').value = ''; $('chgPass').value = '';
    } catch (e) { $('cryptoErr').textContent = e.message; }
  });

  $('disableCrypto').addEventListener('click', async () => {
    $('cryptoErr').textContent = '';
    const cur = $('curPass').value;
    if (!cur) { $('cryptoErr').textContent = '请输入当前主密码'; return; }
    if (!confirm('关闭加密后，本地存储与后续备份文件将以明文保存。继续？')) return;
    try {
      await send('crypto.removePassword', { currentPassword: cur });
      settings = await send('settings.get');
      $('curPass').value = '';
      renderCrypto(); refreshChips();
      toast('已关闭加密');
    } catch (e) { $('cryptoErr').textContent = e.message; }
  });

  $('autoLock').addEventListener('change', async () => {
    await send('settings.set', { autoLockMinutes: Number($('autoLock').value) || 0 });
    settings = await send('settings.get');
    toast('已保存');
  });

  $('lockNow').addEventListener('click', async () => {
    await send('vault.lock');
    refreshChips();
    toast('已锁定');
  });

  /* ================= auto backup ================= */
  function renderAutoBackup() {
    $('autoBackupEnabled').checked = !!settings.autoBackup.enabled;
    $('autoBackupHours').value = settings.autoBackup.intervalHours;
    $('snapEnabled').checked = !!settings.localSnapshot.enabled;
    $('snapHours').value = settings.localSnapshot.intervalHours;
    $('snapKeep').value = settings.localSnapshot.keep;
    $('exportEnabled').checked = !!settings.fileExport.enabled;
    $('exportDays').value = settings.fileExport.intervalDays;
    $('autofillEnabled').checked = !!settings.autofill.enabled;
    if ($('syncAutoPush')) $('syncAutoPush').checked = !!(settings.sync && settings.sync.autoPush);
  }

  async function saveSettings(patch) {
    settings = await send('settings.set', { patch }).then((r) => r.settings);
    refreshChips();
  }

  $('autoBackupEnabled').addEventListener('change', async (e) => {
    await saveSettings({ autoBackup: { enabled: e.target.checked } });
    toast(e.target.checked ? '已开启定时上传' : '已关闭定时上传');
  });
  $('autoBackupHours').addEventListener('change', async (e) => {
    await saveSettings({ autoBackup: { intervalHours: Number(e.target.value) || 12 } });
    toast('已保存');
  });
  $('snapEnabled').addEventListener('change', async (e) => {
    await saveSettings({ localSnapshot: { enabled: e.target.checked } });
    toast('已保存');
  });
  $('snapHours').addEventListener('change', async (e) => {
    await saveSettings({ localSnapshot: { intervalHours: Number(e.target.value) || 6 } });
    toast('已保存');
  });
  $('snapKeep').addEventListener('change', async (e) => {
    await saveSettings({ localSnapshot: { keep: Number(e.target.value) || 10 } });
    toast('已保存');
  });
  $('exportEnabled').addEventListener('change', async (e) => {
    await saveSettings({ fileExport: { enabled: e.target.checked } });
    toast(e.target.checked ? '已开启定期导出（需授予下载权限）' : '已关闭定期导出');
  });
  $('exportDays').addEventListener('change', async (e) => {
    await saveSettings({ fileExport: { intervalDays: Number(e.target.value) || 7 } });
    toast('已保存');
  });
  $('autofillEnabled').addEventListener('change', async (e) => {
    await saveSettings({ autofill: { enabled: e.target.checked } });
    toast('已保存');
  });

  $('backupNow').addEventListener('click', async () => {
    const btn = $('backupNow');
    btn.disabled = true; const old = btn.textContent; btn.textContent = '备份中…';
    try {
      const provider = settings.activeProvider;
      if (!provider || provider === 'none') throw new Error('请先选择并配置一个备份渠道');
      const res = await send('backup.now', { provider });
      $('backupStatusText').textContent = '上次备份：' + F2A.timeAgo(F2A.nowIso());
      toast('已备份到 ' + res.location);
    } catch (e) { toast('备份失败：' + e.message, true); }
    finally { btn.disabled = false; btn.textContent = old; refreshStatus(); }
  });

  $('restoreFromCloud').addEventListener('click', async () => {
    const provider = settings.activeProvider;
    if (!provider || provider === 'none') { toast('请先选择一个备份渠道', true); return; }
    if (!confirm('从云端恢复会覆盖当前本地保管库，确定继续？')) return;
    try {
      let res = await send('backup.restoreFromProvider', { provider });
      if (res && res.needsPassword) {
        const pw = prompt('该备份已加密，请输入备份时使用的主密码：');
        if (pw === null) return;
        res = await send('backup.restoreFromProvider', { provider, password: pw });
      }
      if (!res.ok) throw new Error('恢复失败');
      toast(`恢复完成，共 ${res.entries} 个账户`);
      await reloadAll();
    } catch (e) { toast('恢复失败：' + e.message, true); }
  });

  $('snapshotNow').addEventListener('click', async () => {
    try {
      const res = await send('backup.snapshotNow');
      toast(res.skipped ? '内容未变化，已跳过' : '快照已生成');
      renderSnapshots();
      refreshStatus();
    } catch (e) { toast(e.message, true); }
  });

  $('exportFileNow').addEventListener('click', async () => {
    try {
      const { json } = await send('backup.buildJson');
      const name = `2fa-helper-backup-${new Date().toISOString().slice(0, 10)}.json`;
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast('已导出 ' + name);
      refreshStatus();
    } catch (e) { toast(e.message, true); }
  });

  /* ================= snapshots table ================= */
  async function renderSnapshots() {
    const list = await send('backup.snapshots').catch(() => []);
    const tbody = $('snapshotTable').querySelector('tbody');
    tbody.innerHTML = '';
    $('snapshotEmpty').hidden = list.length > 0;
    $('snapshotTable').hidden = list.length === 0;
    for (const s of list) {
      const tr = document.createElement('tr');
      for (const text of [F2A.fmtDateTime(s.ts), String(s.entries), F2A.humanSize(s.size), s.encrypted ? '是' : '否']) {
        const cell = document.createElement('td');
        cell.textContent = text;
        tr.appendChild(cell);
      }
      const td = document.createElement('td');
      td.style.textAlign = 'right';

      const rs = document.createElement('button');
      rs.className = 'btn ghost row-btn';
      rs.textContent = '恢复';
      rs.addEventListener('click', async () => {
        if (!confirm('用这个快照覆盖当前保管库？')) return;
        try {
          let res = await send('backup.snapshotRestore', { ts: s.ts });
          if (res && res.needsPassword) { toast('该快照已加密，请输入密码', true); return; }
          toast('已恢复');
          await reloadAll();
        } catch (e) {
          if (/主密码|password/i.test(e.message)) {
            const pw = prompt('请输入该快照的主密码：');
            if (pw === null) return;
            try {
              await send('backup.snapshotRestore', { ts: s.ts, password: pw });
              toast('已恢复');
              await reloadAll();
              return;
            } catch (e2) { toast(e2.message, true); return; }
          }
          toast(e.message, true);
        }
      });

      const del = document.createElement('button');
      del.className = 'btn ghost row-btn';
      del.textContent = '删除';
      del.addEventListener('click', async () => {
        if (!confirm('删除这个快照？')) return;
        await send('backup.snapshotDelete', { ts: s.ts });
        renderSnapshots();
        toast('已删除');
      });

      td.append(rs, del);
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
  }

  /* ================= import / restore ================= */
  $('importBtn').addEventListener('click', async () => {
    $('importErr').textContent = '';
    $('importResult').textContent = '';
    const text = $('importText').value.trim();
    if (!text) return;
    try {
      const parsed = await send('entry.parseOtpauth', { uri: text });
      const res = await send('entry.import', { entries: parsed.entries, mode: 'merge' });
      $('importResult').textContent = `导入 ${parsed.entries.length} 条，当前共 ${res.total} 条`;
      $('importText').value = '';
      toast('导入完成');
      refreshStatus();
    } catch (e) {
      $('importErr').textContent = e.message;
      if (e.code === 'LOCKED') $('importErr').textContent = '保管库已锁定，请先在弹窗中解锁';
    }
  });

  $('restoreFile').addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    const text = await file.text();
    $('importErr').textContent = '';
    if (!confirm('用该备份文件覆盖当前保管库？')) { ev.target.value = ''; return; }
    try {
      let res = await send('backup.applyText', { text });
      if (res && res.needsPassword) {
        const pw = prompt('该备份已加密，请输入主密码：');
        if (pw === null) { ev.target.value = ''; return; }
        res = await send('backup.applyText', { text, password: pw });
      }
      if (!res.ok) throw new Error('恢复失败');
      toast(`恢复完成，共 ${res.entries} 个账户`);
      await reloadAll();
    } catch (e) {
      $('importErr').textContent = e.message;
    } finally {
      ev.target.value = '';
    }
  });

  /* ================= reset ================= */
  $('resetAll').addEventListener('click', async () => {
    if (!confirm('这会删除本地所有账户、快照和配置（云端备份不受影响）。确定？')) return;
    await api.storage.local.clear();
    try { await api.storage.session.clear(); } catch (e) { /* noop */ }
    toast('已清除，正在重新加载…');
    setTimeout(() => location.reload(), 900);
  });

  /* ================= status ================= */
  function refreshChips() {
    const enc = !!settings.encryptionEnabled;
    $('chipEnc').textContent = enc ? '已加密' : '未加密';
    $('chipEnc').className = 'chip' + (enc ? ' ok' : '');
    const provider = (PROVIDERS.find((p) => p.id === settings.activeProvider) || {}).label || '未启用';
    $('chipBackup').textContent = '渠道：' + provider;
  }

  async function refreshStatus() {
    try {
      const st = await send('vault.state');
      $('chipLock').textContent = st.locked ? '🔒 已锁定' : '🔓 已解锁';
      $('chipLock').className = 'chip' + (st.locked ? ' warn' : ' ok');
    } catch (e) { $('chipLock').textContent = '状态未知'; }

    try {
      const status = await send('backup.status');
      const bits = [];
      bits.push('上次云端备份：' + (status.lastBackupAt ? F2A.fmtDateTime(status.lastBackupAt) : '从未'));
      if (status.lastBackupOk === false && status.lastError) bits.push('错误：' + status.lastError);
      bits.push('上次本地保存：' + (status.lastLocalSaveAt ? F2A.fmtDateTime(status.lastLocalSaveAt) : '从未'));
      $('backupStatusText').textContent = bits.join(' · ');
    } catch (e) { /* ignore */ }
  }

  /* ================= 二维码扫码 ================= */
  let cameraStream = null;
  let cameraTimer = null;

  function setScanBadge(text, kind) {
    const b = $('scanBadge');
    b.textContent = text;
    b.className = 'badge' + (kind === 'on' ? '' : ' off');
  }

  async function handleScannedText(text) {
    $('scanErr').textContent = '';
    const preview = $('scanPreview');
    $('scanStatus').textContent = '';
    let parsed;
    try {
      parsed = await send('scan.handle', { text });
    } catch (e) {
      $('scanErr').textContent = e.message;
      setScanBadge('未识别', 'off');
      return;
    }

    if (parsed.action === 'sync-join') {
      stopCamera();
      setScanBadge('配对码', 'on');
      preview.hidden = false;
      preview.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'box';
      const t = document.createElement('span');
      t.className = 'type';
      t.textContent = '同步配对码';
      const desc = document.createElement('span');
      desc.textContent = '用这个配对码加入同步组并拉取云端保管库？';
      const go = document.createElement('button');
      go.className = 'btn primary';
      go.textContent = '加入同步组';
      go.addEventListener('click', async () => {
        go.disabled = true;
        try {
          await doJoinSync(parsed.code);
          preview.hidden = true;
        } finally { go.disabled = false; }
      });
      box.append(t, desc, go);
      preview.appendChild(box);
      return;
    }

    if (parsed.action === 'restore') {
      stopCamera();
      setScanBadge('备份文件', 'on');
      if (!confirm('识别到加密备份文件，导入会覆盖当前保管库，继续？')) return;
      try {
        let res = await send('backup.applyText', { text: parsed.text });
        if (res && res.needsPassword) {
          const pw = prompt('该备份已加密，请输入备份时使用的主密码：');
          if (pw === null) return;
          res = await send('backup.applyText', { text: parsed.text, password: pw });
        }
        toast(`已恢复 ${res.entries} 个条目`);
        await reloadAll();
        setScanBadge('已恢复', 'on');
      } catch (e) {
        $('scanErr').textContent = e.message;
      }
      return;
    }

    // import
    stopCamera();
    try {
      const res = await send('entry.import', { entries: parsed.entries, mode: 'merge' });
      const kinds = new Set(parsed.entries.map((e) => (e.kind === 'passkey' ? 'passkey' : 'otp')));
      const kindLabel = kinds.has('passkey') && kinds.size === 1 ? 'Passkey' : '验证码账户';
      setScanBadge('已导入', 'on');
      preview.hidden = false;
      preview.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'box';
      const t = document.createElement('span');
      t.className = 'type';
      t.textContent = '✓ 已导入 ' + parsed.entries.length + ' 条' + kindLabel;
      const desc = document.createElement('span');
      desc.textContent = '当前共 ' + res.total + ' 条';
      box.append(t, desc);
      preview.appendChild(box);
      toast('导入完成');
      refreshStatus();
    } catch (e) {
      $('scanErr').textContent = e.message === 'LOCKED' || e.code === 'LOCKED'
        ? '保管库已锁定，请先在弹窗中解锁后重试'
        : e.message;
    }
  }

  async function decodeAndHandle(source, isFile) {
    $('scanErr').textContent = '';
    setScanBadge('识别中…', 'off');
    try {
      const imageData = isFile
        ? F2A.qr.grabImageData(await F2A.qr.fileToImage(source))
        : F2A.qr.grabImageData(source);
      const text = F2A.qr.decodeImageData(imageData);
      if (!text) {
        setScanBadge('未识别', 'off');
        $('scanErr').textContent = '图片里没有找到可识别的二维码，试试更清晰或更大的截图。';
        return;
      }
      await handleScannedText(text);
    } catch (e) {
      setScanBadge('出错', 'off');
      $('scanErr').textContent = e.message;
    }
  }

  function stopCamera() {
    if (cameraTimer) cancelAnimationFrame(cameraTimer);
    cameraTimer = null;
    if (cameraStream) {
      for (const track of cameraStream.getTracks()) track.stop();
      cameraStream = null;
    }
    $('scanVideo').hidden = true;
    $('scanStop').hidden = true;
    $('scanCamera').disabled = false;
  }

  async function startCamera() {
    $('scanErr').textContent = '';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      $('scanErr').textContent = '当前浏览器不支持摄像头';
      return;
    }
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } } });
    } catch (e) {
      $('scanErr').textContent = '无法打开摄像头：' + e.message;
      return;
    }
    const video = $('scanVideo');
    video.srcObject = cameraStream;
    video.hidden = false;
    $('scanStop').hidden = false;
    $('scanCamera').disabled = true;
    $('scanStatus').textContent = '对准二维码…';
    await video.play().catch(() => {});
    setScanBadge('摄像头', 'on');

    const canvas = document.createElement('canvas');
    const tickFrame = () => {
      if (!cameraStream) return;
      try {
        if (video.readyState >= 2) {
          const imageData = F2A.qr.grabImageData(video, { canvas, max: 900 });
          const text = F2A.qr.decodeImageData(imageData);
          if (text) {
            stopCamera();
            $('scanStatus').textContent = '';
            handleScannedText(text);
            return;
          }
        }
      } catch (e) { /* keep scanning */ }
      cameraTimer = requestAnimationFrame(tickFrame);
    };
    cameraTimer = requestAnimationFrame(tickFrame);
  }

  function initScan() {
    const zone = $('scanZone');
    const fileInput = $('scanFile');

    zone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async (ev) => {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (file) await decodeAndHandle(file, true);
    });

    for (const evName of ['dragenter', 'dragover']) {
      zone.addEventListener(evName, (ev) => { ev.preventDefault(); zone.classList.add('drag'); });
    }
    for (const evName of ['dragleave', 'drop']) {
      zone.addEventListener(evName, (ev) => { ev.preventDefault(); zone.classList.remove('drag'); });
    }
    zone.addEventListener('drop', async (ev) => {
      const file = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) await decodeAndHandle(file, true);
      else $('scanErr').textContent = '请拖入图片文件';
    });

    document.addEventListener('paste', async (ev) => {
      const items = (ev.clipboardData && ev.clipboardData.items) || [];
      for (const item of items) {
        if (item.type && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) { await decodeAndHandle(file, true); return; }
        }
      }
      const text = (ev.clipboardData || window.clipboardData).getData('text');
      if (/^(otpauth(-migration)?:\/\/|f2a-sync:|f2a-passkey:)/.test((text || '').trim())) {
        await handleScannedText(text.trim());
      }
    });

    $('scanCamera').addEventListener('click', startCamera);
    $('scanStop').addEventListener('click', () => { stopCamera(); setScanBadge('就绪', 'off'); });

    if (!F2A.qr || !F2A.qr.hasDecoder()) {
      setScanBadge('解码器缺失', 'off');
      $('scanErr').textContent = '二维码解码器未加载（vendor/jsqr.js）';
      $('scanCamera').disabled = true;
    }
  }

  /* ================= 端到端同步 ================= */
  let syncState = null;

  async function renderSync() {
    let st;
    try {
      st = await send('sync.status');
    } catch (e) {
      $('syncBadge').textContent = '不可用';
      $('syncBadge').className = 'badge off';
      $('syncStatusText').textContent = e.message;
      return;
    }
    syncState = st;
    const on = !!st.enabled;
    $('syncBadge').textContent = on ? '已启用' : (st.available ? '未启用' : '不可用');
    $('syncBadge').className = 'badge' + (on ? '' : ' off');
    $('syncOff').hidden = on;
    $('syncOn').hidden = !on;

    if (on) {
      const codeRes = await send('sync.code').catch(() => ({ code: '' }));
      $('syncCode').textContent = codeRes.code ? codeRes.code : '（本机缺少配对码，请重新配对）';
      $('syncAutoPush').checked = !!(settings.sync && settings.sync.autoPush);
      // the coding key is only rendered on demand
      $('syncQrPanel').hidden = true;
    }

    const host = $('syncStatusText');
    host.textContent = '';
    const line = (parts) => {
      const div = document.createElement('div');
      for (const part of parts) {
        if (typeof part === 'string') {
          div.appendChild(document.createTextNode(part));
        } else {
          const b = document.createElement('b');
          b.textContent = part.text;
          if (part.accent) b.style.color = 'var(--accent)';
          div.appendChild(b);
        }
      }
      host.appendChild(div);
    };
    if (st.hasRemote) {
      line(['云端：', { text: F2A.fmtDateTime(st.remoteUpdatedAt) }, ` · ${st.remoteEntryCount} 条 · 推送于 ${F2A.timeAgo(st.pushedAt)}`]);
    } else if (on) {
      line(['云端：', { text: '还没有数据' }, '，点「立即推送」上传首份密文']);
    }
    if (st.remoteIsNewer) {
      line([{ text: '⚠ 云端比本机更新', accent: true }, ' —— 点「从云端拉取」应用（会覆盖本机）']);
    }
    if (st.lastPushedAt) line(['本机上次推送：' + F2A.timeAgo(st.lastPushedAt)]);
    if (st.lastPulledAt) line(['上次应用云端版本：' + F2A.timeAgo(st.lastPulledAt)]);
    if (!st.available) line(['当前环境不提供 storage.sync（隐私窗口或被策略禁用）']);
    if (!host.childNodes.length) host.textContent = '—';
  }

  async function doJoinSync(code) {
    $('syncErr').textContent = '';
    try {
      const res = await send('sync.join', { code });
      toast(res.hasRemote
        ? `已加入同步组，云端有 ${res.remoteEntryCount} 条记录，可点「从云端拉取」`
        : '已加入同步组，云端暂无数据');
      settings = await send('settings.get');
      await renderSync();
    } catch (e) {
      $('syncErr').textContent = e.message;
    }
  }

  function initSync() {
    $('syncEnable').addEventListener('click', async () => {
      $('syncErr').textContent = '';
      const btn = $('syncEnable');
      btn.disabled = true;
      try {
        const res = await send('sync.enable');
        settings = await send('settings.get');
        await renderSync();
        toast('已启用同步，配对码已生成');
        const code = $('syncCode').textContent;
        prompt('请妥善保存这个配对码（新设备需要它才能解密云端数据）：', code);
      } catch (e) {
        $('syncErr').textContent = e.message;
      } finally { btn.disabled = false; }
    });

    $('syncJoinBtn').addEventListener('click', () => {
      $('syncJoinRow').hidden = !$('syncJoinRow').hidden;
    });

    $('syncJoinDo').addEventListener('click', async () => {
      const code = $('syncJoinCode').value.trim();
      if (!code) { $('syncErr').textContent = '请输入配对码'; return; }
      await doJoinSync(code);
      $('syncJoinCode').value = '';
    });

    $('syncCopyCode').addEventListener('click', async () => {
      await navigator.clipboard.writeText($('syncCode').textContent);
      toast('配对码已复制');
    });

    $('syncShowQr').addEventListener('click', async () => {
      const panel = $('syncQrPanel');
      if (!panel.hidden) { panel.hidden = true; return; }
      try {
        if (!F2A.qr || !F2A.qr.hasEncoder()) throw new Error('二维码生成器未加载');
        const res = await send('sync.code');
        if (!res.raw) throw new Error('本机没有配对码');
        F2A.qr.toCanvas($('syncQrCanvas'), 'f2a-sync:v1:' + res.raw, { size: 240 });
        panel.hidden = false;
      } catch (e) {
        $('syncErr').textContent = e.message;
      }
    });

    $('syncAutoPush').addEventListener('change', async (e) => {
      await saveSettings({ sync: { autoPush: e.target.checked } });
      toast('已保存');
    });

    $('syncPush').addEventListener('click', async () => {
      $('syncErr').textContent = '';
      const btn = $('syncPush');
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = '推送中…';
      try {
        const res = await send('sync.push');
        toast(res.skipped
          ? '内容与云端一致，无需推送'
          : `已推送（${res.chunks} 片 / ${F2A.humanSize(res.size)} / ${res.entryCount} 条）`);
        await renderSync();
        refreshStatus();
      } catch (e) {
        $('syncErr').textContent = e.message;
      } finally { btn.disabled = false; btn.textContent = old; }
    });

    $('syncPull').addEventListener('click', async () => {
      $('syncErr').textContent = '';
      if (!confirm('从云端拉取会覆盖本机保管库，继续？')) return;
      try {
        let res = await send('sync.pull');
        if (res && res.needsPassword) {
          const pw = prompt('云端保管库已加密，请输入主密码：');
          if (pw === null) return;
          res = await send('sync.pull', { password: pw });
        }
        if (!res.ok) throw new Error('拉取失败');
        toast(`已应用云端版本，共 ${res.entries} 条`);
        await reloadAll();
      } catch (e) {
        $('syncErr').textContent = e.message;
      }
    });

    $('syncDisable').addEventListener('click', async () => {
      if (!confirm('停止同步并从浏览器账号的 storage.sync 中删除云端密文？本机数据不受影响。')) return;
      try {
        await send('sync.disable', { wipeRemote: true });
        settings = await send('settings.get');
        await renderSync();
        toast('已停止同步');
      } catch (e) {
        $('syncErr').textContent = e.message;
      }
    });
  }

  /* ================= 导出全部 ================= */
  function initExportAll() {
    $('exportAll').addEventListener('click', async () => {
      try {
        const res = await send('entry.listAll').catch((e) => {
          if (e.code === 'LOCKED') throw new Error('保管库已锁定，请先在弹窗中解锁');
          throw e;
        });
        const entries = res.entries || [];
        const blob = new Blob([JSON.stringify({ format: 'f2a-entries', exportedAt: F2A.nowIso(), entries }, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `2fa-helper-entries-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
        toast(`已导出 ${entries.length} 条（含 ${entries.filter((e) => e.kind === 'passkey').length} 个 Passkey）`);
      } catch (e) {
        toast('导出失败：' + e.message, true);
      }
    });
  }

  /* ================= boot ================= */
  async function reloadAll() {
    settings = await send('settings.get');
    secretsInfo = await send('secrets.get').catch(() => null);
    try {
      const r = await send('providers.redirect');
      redirectUrl = r.url;
    } catch (e) { redirectUrl = ''; }
    if (!['none', 'webdav', 'gdrive', 'dropbox', 'onedrive'].includes(activeTab)) activeTab = 'none';
    if (activeTab === 'none' && settings.activeProvider && settings.activeProvider !== 'none') activeTab = settings.activeProvider;
    renderTabs();
    renderPanels();
    renderCrypto();
    renderAutoBackup();
    renderSnapshots();
    renderSync();
    refreshChips();
    refreshStatus();
    $('versionBadge').textContent = 'v' + (api.runtime.getManifest().version || '1.0.0');
  }

  initScan();
  initSync();
  initExportAll();
  reloadAll().catch((e) => toast('初始化失败：' + e.message, true));
})();
