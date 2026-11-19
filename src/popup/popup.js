/* 2FA Helper — popup controller */
(function () {
  'use strict';
  const F2A = globalThis.F2A;
  const api = F2A.api;
  const $ = (id) => document.getElementById(id);

  const state = {
    entries: [],
    settings: null,
    filter: '',
    editingId: null,
    formKind: 'otp',
    detailId: null,
    codes: new Map(),      // id -> {code, counter, period, remaining, progress}
    rows: new Map(),       // id -> {el, codeEl, ringEl, fgEl, C}
    tick: null,
  };

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (e2) { return false; }
    }
  }

  async function send(type, payload = {}) {
    let res;
    try {
      res = await api.runtime.sendMessage(Object.assign({ type }, payload));
    } catch (e) {
      throw new Error('后台连接失败：' + (e.message || e));
    }
    if (!res) throw new Error('后台无响应');
    if (!res.ok) {
      const err = new Error(res.error || '未知错误');
      err.code = res.code;
      throw err;
    }
    return res.data;
  }

  function show(view) {
    for (const v of ['lockView', 'mainView', 'formView', 'detailView', 'importView']) $(v).hidden = (v !== view);
  }

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 1700);
  }

  const AVATAR_COLORS = ['#0f766e', '#7c3aed', '#b45309', '#1d4ed8', '#be123c', '#15803d', '#a16207'];
  function colorFor(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 997;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }

  function formatCode(code) {
    const s = String(code || '');
    if (s.length === 6 || s.length === 7) return s.slice(0, 3) + ' ' + s.slice(3);
    if (s.length === 8) return s.slice(0, 4) + ' ' + s.slice(4);
    return s;
  }

  const isPasskey = (e) => e && e.kind === 'passkey';

  /* ---------------- rendering ---------------- */
  function visibleEntries() {
    const q = state.filter.trim().toLowerCase();
    if (!q) return state.entries;
    return state.entries.filter((e) =>
      (e.issuer || '').toLowerCase().includes(q) ||
      (e.account || '').toLowerCase().includes(q) ||
      (e.urls || []).some((u) => u.toLowerCase().includes(q)) ||
      (isPasskey(e) && (e.passkey?.rpId || '').toLowerCase().includes(q)) ||
      (e.tags || []).some((t) => String(t).toLowerCase().includes(q))
    );
  }

  function makeIconButton(label, title, onClick) {
    const b = document.createElement('button');
    b.className = 'icon-btn';
    b.title = title;
    b.textContent = label;
    b.addEventListener('click', (ev) => { ev.stopPropagation(); onClick(); });
    return b;
  }

  function renderList() {
    const list = $('list');
    const items = visibleEntries();
    list.innerHTML = '';
    state.rows.clear();

    if (!state.entries.length) {
      $('emptyState').hidden = false;
      list.hidden = true;
    } else {
      $('emptyState').hidden = true;
      list.hidden = false;
    }

    const R = 8;
    const C = 2 * Math.PI * R;

    for (const e of items) {
      const li = document.createElement('li');
      li.className = 'row';
      li.dataset.id = e.id;

      const color = colorFor(e.issuer || e.account || '');
      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.textContent = (e.issuer || e.account || '?').slice(0, 1);
      avatar.style.color = color;
      avatar.style.background = 'color-mix(in srgb, ' + color + ' 14%, transparent)';

      const meta = document.createElement('div');
      meta.className = 'meta';
      const issuer = document.createElement('div');
      issuer.className = 'issuer';
      issuer.textContent = e.issuer || '(未命名)';
      const account = document.createElement('div');
      account.className = 'account';
      account.textContent = e.account || (isPasskey(e) ? (e.passkey?.rpId || 'passkey') : '—');
      meta.append(issuer, account);

      const wrap = document.createElement('div');
      wrap.className = 'code-wrap';

      let codeEl = null;
      let svg = null;
      let fgc = null;

      if (isPasskey(e)) {
        const badge = document.createElement('span');
        badge.className = 'pk-badge';
        badge.textContent = 'PASSKEY';
        wrap.appendChild(badge);
        li.title = '点击查看 Passkey 详情';
      } else {
        codeEl = document.createElement('div');
        codeEl.className = 'code';
        codeEl.textContent = '··· ···';

        const svgNS = 'http://www.w3.org/2000/svg';
        svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('class', 'ring');
        svg.setAttribute('viewBox', '0 0 20 20');
        const bgc = document.createElementNS(svgNS, 'circle');
        bgc.setAttribute('class', 'bg');
        bgc.setAttribute('cx', '10'); bgc.setAttribute('cy', '10'); bgc.setAttribute('r', String(R));
        fgc = document.createElementNS(svgNS, 'circle');
        fgc.setAttribute('class', 'fg');
        fgc.setAttribute('cx', '10'); fgc.setAttribute('cy', '10'); fgc.setAttribute('r', String(R));
        fgc.setAttribute('stroke-dasharray', String(C));
        fgc.setAttribute('stroke-dashoffset', '0');
        svg.append(bgc, fgc);
        wrap.append(codeEl, svg);
        li.title = '点击复制验证码';
      }

      const tools = document.createElement('div');
      tools.className = 'row-tools';
      tools.append(
        makeIconButton('ⓘ', '详情', () => openDetail(e.id)),
        makeIconButton('✎', '编辑', () => openForm(e.id)),
        makeIconButton('🗑', '删除', () => deleteEntry(e))
      );

      li.append(avatar, meta, wrap, tools);

      li.addEventListener('click', async (ev) => {
        if (ev.target.closest('.row-tools')) return;
        if (isPasskey(e)) { openDetail(e.id); return; }
        const c = state.codes.get(e.id);
        if (!c || !c.code) return;
        if (await copyText(c.code)) toast('已复制 ' + formatCode(c.code));
        else toast('复制失败，请手动记下 ' + formatCode(c.code));
      });

      list.appendChild(li);
      state.rows.set(e.id, { el: li, codeEl, ringEl: svg, fgEl: fgc, C });
    }

    if (state.entries.length && !items.length) {
      const li = document.createElement('li');
      li.className = 'row';
      li.style.cursor = 'default';
      const note = document.createElement('div');
      note.className = 'meta muted';
      note.textContent = '没有匹配的账户';
      li.appendChild(note);
      list.appendChild(li);
    }
  }

  /* ---------------- code ticking ---------------- */
  function currentCounter(entry, now) {
    const period = Number(entry.period || 30) || 30;
    return Math.floor(now / 1000 / period);
  }

  async function updateCodes() {
    const now = Date.now();
    const visible = visibleEntries();

    for (const e of visible) {
      if (isPasskey(e)) continue;
      const period = Number(e.period || 30) || 30;
      const counter = currentCounter(e, now);
      const cached = state.codes.get(e.id);
      const isHotp = (e.type || 'totp') === 'hotp';
      if (!cached || cached.counter !== counter || cached.error) {
        if (!isHotp && cached && cached.error) continue;
        try {
          state.codes.set(e.id, await F2A.totp.generate(e, now));
        } catch (err) {
          state.codes.set(e.id, { error: err.message, code: '出错', counter, period });
        }
      }
    }

    for (const [id, row] of state.rows) {
      const c = state.codes.get(id);
      if (!c || !row.codeEl) continue;
      const entry = state.entries.find((x) => x.id === id);
      const period = c.period || Number(entry && entry.period) || 30;
      if (c.error) { row.codeEl.textContent = '出错'; continue; }
      row.codeEl.textContent = formatCode(c.code);
      const remaining = c.type === 'hotp' ? period : Math.max(0, period - ((now / 1000) % period));
      const ratio = Math.max(0, Math.min(1, remaining / period));
      row.fgEl.setAttribute('stroke-dashoffset', String(row.C * (1 - ratio)));
      const urgent = remaining <= 5;
      row.codeEl.classList.toggle('urgent', urgent);
      row.ringEl.classList.toggle('urgent', urgent);
      row.el.title = `点击复制验证码（${Math.ceil(remaining)} 秒后刷新）`;
    }

    if (state.detailId) paintDetailCode(now);
  }

  function paintDetailCode(now) {
    const c = state.codes.get(state.detailId);
    const el = document.querySelector('.detail-hero .big-code');
    const sub = document.querySelector('.detail-hero .sub');
    if (!c || !el) return;
    const entry = state.entries.find((x) => x.id === state.detailId);
    const period = c.period || Number(entry && entry.period) || 30;
    if (c.error) { el.textContent = '出错'; if (sub) sub.textContent = c.error; return; }
    el.textContent = formatCode(c.code);
    const remaining = c.type === 'hotp' ? 0 : Math.max(0, period - ((now / 1000) % period));
    if (sub) {
      sub.textContent = c.type === 'hotp'
        ? `HOTP · 第 ${c.counter} 次`
        : `${Math.ceil(remaining)} 秒后刷新 · 每 ${period} 秒`;
    }
    el.classList.toggle('urgent', remaining <= 5);
  }

  function startTicking() {
    stopTicking();
    updateCodes();
    state.tick = setInterval(updateCodes, 1000);
  }
  function stopTicking() {
    if (state.tick) clearInterval(state.tick);
    state.tick = null;
  }

  /* ---------------- status footer ---------------- */
  async function refreshStatus() {
    try {
      const status = await send('backup.status');
      const LABELS = { folder: '文件夹', s3: '对象存储', webdav: 'WebDAV', gdrive: 'Google Drive', dropbox: 'Dropbox', onedrive: 'OneDrive' };
      const parts = [];
      if (status.lastBackupAt) {
        const name = LABELS[status.lastBackupProvider] || '';
        parts.push(`云端${name ? ' ' + name : ''} ${F2A.timeAgo(status.lastBackupAt)}${status.lastBackupOk === false ? ' ⚠' : ' ✓'}`);
      } else {
        parts.push('尚未云端备份');
      }
      if (status.syncLastPushAt) parts.push(`同步 ${F2A.timeAgo(status.syncLastPushAt)}`);

      // a newer remote vault from storage.sync is worth surfacing here
      let syncFlag = '';
      try {
        const st = await send('sync.status');
        if (st.enabled && st.remoteIsNewer) syncFlag = ' · 云端有更新 ⟳';
      } catch (e) { /* sync unavailable */ }

      $('statusText').textContent = parts.join(' · ') + syncFlag;
      $('statusText').title = status.lastError || '';
      $('statusText').style.color = syncFlag ? 'var(--accent)' : '';
    } catch (e) {
      $('statusText').textContent = '状态不可用';
    }
  }

  /* ---------------- forms ---------------- */
  const OTP_IDS = ['fIssuer', 'fAccount', 'fSecret', 'fUrls'];
  const PK_IDS = ['pRpId', 'pRpName', 'pUserName', 'pUserHandle', 'pCredentialId', 'pPublicKey', 'pPrivateJwk', 'pSignCount', 'pNote'];

  function setFormKind(kind) {
    state.formKind = kind;
    for (const b of $('kindSwitch').querySelectorAll('button')) {
      b.classList.toggle('active', b.dataset.kind === kind);
    }
    $('otpFields').hidden = kind !== 'otp';
    $('passkeyFields').hidden = kind !== 'passkey';
    $('formTitle').textContent = state.editingId
      ? (kind === 'passkey' ? '编辑 Passkey' : '编辑账户')
      : (kind === 'passkey' ? '添加 Passkey' : '添加账户');
  }

  function b64url(bytes) {
    return F2A.bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function openForm(id) {
    state.editingId = id || null;
    const e = id ? state.entries.find((x) => x.id === id) : null;
    const kind = isPasskey(e) ? 'passkey' : 'otp';

    $('fIssuer').value = e && !isPasskey(e) ? e.issuer : '';
    $('fAccount').value = e && !isPasskey(e) ? e.account : '';
    $('fSecret').value = e && !isPasskey(e) ? e.secret : '';
    $('fUrls').value = e && !isPasskey(e) ? (e.urls || []).join(', ') : '';
    $('fType').value = e && !isPasskey(e) ? e.type || 'totp' : 'totp';
    $('fDigits').value = String(e && !isPasskey(e) ? e.digits || 6 : 6);
    $('fAlgorithm').value = e && !isPasskey(e) ? e.algorithm || 'SHA1' : 'SHA1';
    $('fPeriod').value = e && !isPasskey(e) ? e.period || 30 : 30;
    $('fCounter').value = e && !isPasskey(e) ? e.counter || 0 : 0;

    const pk = (e && e.passkey) || {};
    $('pRpId').value = pk.rpId || '';
    $('pRpName').value = pk.rpName || '';
    $('pUserName').value = pk.userName || '';
    $('pUserHandle').value = pk.userHandle || '';
    $('pCredentialId').value = pk.credentialId || '';
    $('pPublicKey').value = pk.publicKey || '';
    $('pPrivateJwk').value = pk.privateKeyJwk || '';
    $('pSignCount').value = String(pk.signCount || 0);
    $('pNote').value = pk.note || '';

    $('formErr').textContent = '';
    $('deleteEntryBtn').hidden = !e;
    setFormKind(kind);
    show('formView');
    setTimeout(() => (kind === 'passkey' ? $('pRpId') : $('fIssuer')).focus(), 30);
  }

  async function submitForm(ev) {
    ev.preventDefault();
    $('formErr').textContent = '';

    if (state.formKind === 'passkey') {
      const rpId = $('pRpId').value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (!rpId) { $('formErr').textContent = '请填写依赖方 ID（RP ID）'; return; }
      const credentialId = $('pCredentialId').value.trim() || b64url(F2A.randomBytes(16));
      const userHandle = $('pUserHandle').value.trim() || b64url(F2A.randomBytes(16));
      const entry = {
        id: state.editingId || undefined,
        kind: 'passkey',
        issuer: $('pRpName').value.trim() || rpId,
        account: $('pUserName').value.trim(),
        urls: [rpId],
        passkey: {
          rpId,
          rpName: $('pRpName').value.trim() || rpId,
          userName: $('pUserName').value.trim(),
          userHandle,
          credentialId,
          publicKey: $('pPublicKey').value.trim(),
          algorithm: -7,
          signCount: Number($('pSignCount').value) || 0,
          privateKeyJwk: $('pPrivateJwk').value.trim(),
          note: $('pNote').value.trim(),
          createdAt: (state.entries.find((x) => x.id === state.editingId) || {}).createdAt || F2A.nowIso(),
        },
      };
      await persist(entry);
      return;
    }

    const entry = {
      id: state.editingId || undefined,
      kind: 'otp',
      issuer: $('fIssuer').value.trim(),
      account: $('fAccount').value.trim(),
      secret: $('fSecret').value.replace(/\s|-/g, '').toUpperCase(),
      urls: $('fUrls').value.split(/[\s,，]+/).filter(Boolean),
      type: $('fType').value,
      digits: Number($('fDigits').value),
      algorithm: $('fAlgorithm').value,
      period: Number($('fPeriod').value) || 30,
      counter: Number($('fCounter').value) || 0,
    };
    if (!entry.issuer) { $('formErr').textContent = '请填写网站 / 服务名称'; return; }
    if (!entry.secret) { $('formErr').textContent = '请填写密钥'; return; }
    try {
      F2A.b32decode(entry.secret);
    } catch (e) {
      $('formErr').textContent = '密钥不是有效的 Base32';
      return;
    }
    await persist(entry);
  }

  async function persist(entry) {
    try {
      const res = await send('entry.save', { entry });
      const saved = res.entry;
      const idx = state.entries.findIndex((x) => x.id === saved.id);
      if (idx === -1) state.entries.push(saved); else state.entries[idx] = saved;
      state.entries.sort((a, b) => (a.issuer + a.account).localeCompare(b.issuer + b.account, 'zh-Hans-CN'));
      state.codes.delete(saved.id);
      show('mainView');
      renderList();
      startTicking();
      refreshStatus();
      toast('已保存');
    } catch (e) {
      if (e.code === 'LOCKED') { showLock('保管库已锁定，请重新解锁'); return; }
      $('formErr').textContent = e.message;
    }
  }

  async function deleteEntry(e) {
    if (!confirm(`删除「${e.issuer || e.account}」？`)) return;
    try {
      await send('entry.delete', { id: e.id });
      state.entries = state.entries.filter((x) => x.id !== e.id);
      state.codes.delete(e.id);
      if (state.detailId === e.id) { state.detailId = null; show('mainView'); }
      renderList();
      toast('已删除');
      refreshStatus();
    } catch (err) { toast(err.message); }
  }

  /* ---------------- detail ---------------- */
  function kv(key, value, { copy = false, mono = true } = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'kv';
    const k = document.createElement('div');
    k.className = 'k';
    k.textContent = key;
    const row = document.createElement('div');
    row.className = 'kv-row';
    const v = document.createElement('div');
    v.className = 'v';
    if (!mono) v.style.fontFamily = 'inherit';
    v.textContent = value || '—';
    row.appendChild(v);
    if (copy && value) {
      const b = document.createElement('button');
      b.className = 'mini-btn';
      b.textContent = '复制';
      b.addEventListener('click', async () => {
        toast(await copyText(value) ? '已复制' : '复制失败');
      });
      row.appendChild(b);
    }
    wrap.append(k, row);
    return wrap;
  }

  function actionButton(label, onClick) {
    const b = document.createElement('button');
    b.className = 'mini-btn';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  async function openDetail(id) {
    const e = state.entries.find((x) => x.id === id);
    if (!e) return;
    state.detailId = id;
    show('detailView');
    $('detailTitle').textContent = e.issuer || '(未命名)';
    const body = $('detailBody');
    body.innerHTML = '';

    if (!isPasskey(e)) {
      const hero = document.createElement('div');
      hero.className = 'detail-hero';
      const big = document.createElement('div');
      big.className = 'big-code';
      big.textContent = '··· ···';
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = e.account || '';
      hero.append(big, sub);
      body.appendChild(hero);
      updateCodes();
    } else {
      const pk = e.passkey || {};
      body.appendChild(kv('依赖方 ID (RP ID)', pk.rpId, { copy: true }));
      body.appendChild(kv('用户名', pk.userName, { copy: true, mono: false }));
      if (pk.userDisplayName) body.appendChild(kv('显示名', pk.userDisplayName, { mono: false }));
      body.appendChild(kv('用户句柄 (userHandle)', pk.userHandle, { copy: true }));
      body.appendChild(kv('凭据 ID (credentialId)', pk.credentialId, { copy: true }));
      body.appendChild(kv('算法', pk.algorithm === -7 ? 'ES256 (ECDSA P-256)' : String(pk.algorithm)));
      body.appendChild(kv('签名计数', String(pk.signCount || 0)));
      if (pk.publicKey) body.appendChild(kv('公钥', pk.publicKey, { copy: true }));
      body.appendChild(kv('私钥', pk.privateKeyJwk ? '已在本机加密保存' : '未保存（标准 passkey 私钥只在认证器内）', { mono: false }));
      if (pk.note) body.appendChild(kv('备注', pk.note, { mono: false }));
      body.appendChild(kv('创建时间', F2A.fmtDateTime(pk.createdAt || e.createdAt), { mono: false }));
    }

    // QR: otpauth URI for OTP, f2a-passkey payload for passkeys
    const qrBox = document.createElement('div');
    qrBox.className = 'qr-box';
    const canvas = document.createElement('canvas');
    const cap = document.createElement('div');
    cap.className = 'cap';
    qrBox.append(canvas, cap);
    body.appendChild(qrBox);

    let qrText = '';
    try {
      const payload = await send('entry.qrPayload', { id });
      qrText = payload.text;
      F2A.qr.toCanvas(canvas, qrText, { size: 220 });
      cap.textContent = isPasskey(e)
        ? '用另一台设备的本扩展扫描以导入这个 Passkey 记录（不含私钥）'
        : '用手机上的其他验证器扫描即可导入这个账户';
    } catch (err) {
      cap.textContent = '二维码生成失败：' + err.message;
      canvas.remove();
    }

    const actions = document.createElement('div');
    actions.className = 'detail-actions';
    if (!isPasskey(e)) {
      actions.appendChild(actionButton('复制验证码', async () => {
        const c = state.codes.get(e.id);
        if (!c || !c.code) return toast('验证码尚未生成');
        toast(await copyText(c.code) ? '已复制 ' + formatCode(c.code) : '复制失败');
      }));
    }
    actions.appendChild(actionButton('复制二维码内容', async () => {
      toast(await copyText(qrText) ? '已复制' : '复制失败');
    }));
    actions.appendChild(actionButton('导出此条目 JSON', async () => {
      const data = await send('entry.exportOne', { id });
      const blob = new Blob([JSON.stringify(data.entry, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = (e.issuer || 'entry').replace(/[^\w.-]+/g, '_') + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
      toast('已导出');
    }));
    body.appendChild(actions);
  }

  /* ---------------- views ---------------- */
  function showLock(msg) {
    stopTicking();
    state.detailId = null;
    show('lockView');
    $('lockErr').textContent = msg || '';
    setTimeout(() => $('unlockPassword').focus(), 50);
  }

  async function reload() {
    try {
      const st = await send('vault.state');
      if (st.locked) { showLock(); return; }
      state.entries = st.entries || [];
      state.settings = st.settings || (await send('settings.get'));
      show('mainView');
      renderList();
      startTicking();
      refreshStatus();
      $('lockBtn').hidden = !st.encryptionEnabled;
    } catch (e) {
      showLock(e.message);
    }
  }

  /* ---------------- wiring ---------------- */
  $('unlockForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('lockErr').textContent = '';
    const btn = $('unlockBtn');
    btn.disabled = true;
    try {
      await send('vault.unlock', { password: $('unlockPassword').value });
      $('unlockPassword').value = '';
      await reload();
    } catch (e) {
      $('lockErr').textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  });

  $('search').addEventListener('input', (ev) => {
    state.filter = ev.target.value;
    renderList();
    updateCodes();
  });

  $('addBtn').addEventListener('click', () => openForm(null));
  $('emptyAdd').addEventListener('click', () => openForm(null));
  $('formBack').addEventListener('click', () => { show('mainView'); startTicking(); });
  $('entryForm').addEventListener('submit', submitForm);

  $('kindSwitch').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-kind]');
    if (btn) setFormKind(btn.dataset.kind);
  });

  $('genKeypair').addEventListener('click', async () => {
    try {
      const res = await send('passkey.generate');
      $('pCredentialId').value = res.credentialId;
      $('pPublicKey').value = res.publicKey;
      $('pPrivateJwk').value = res.privateKeyJwk;
      if (!$('pUserHandle').value) $('pUserHandle').value = b64url(F2A.randomBytes(16));
      $('pkAdvanced').open = true;
      toast('已生成 ES256 密钥对');
    } catch (e) {
      $('formErr').textContent = e.message;
    }
  });

  $('deleteEntryBtn').addEventListener('click', async () => {
    if (!state.editingId) return;
    if (!confirm('确定删除这个条目？')) return;
    try {
      await send('entry.delete', { id: state.editingId });
      state.entries = state.entries.filter((x) => x.id !== state.editingId);
      show('mainView');
      renderList();
      startTicking();
      toast('已删除');
    } catch (e) { $('formErr').textContent = e.message; }
  });

  $('detailBack').addEventListener('click', () => {
    state.detailId = null;
    show('mainView');
    startTicking();
  });
  $('detailEdit').addEventListener('click', () => {
    if (state.detailId) openForm(state.detailId);
  });

  $('lockBtn').addEventListener('click', async () => {
    await send('vault.lock');
    state.entries = [];
    state.codes.clear();
    showLock('已锁定');
  });

  $('settingsBtn').addEventListener('click', () => api.runtime.openOptionsPage());
  $('toOptionsFromLock').addEventListener('click', () => api.runtime.openOptionsPage());

  $('backupQuick').addEventListener('click', async () => {
    const btn = $('backupQuick');
    btn.disabled = true;
    btn.textContent = '备份中…';
    try {
      const settings = state.settings || (await send('settings.get'));
      const provider = settings.activeProvider;
      if (!provider || provider === 'none') {
        toast('请先在设置里选择备份渠道');
        api.runtime.openOptionsPage();
        return;
      }
      const res = await send('backup.now', { provider });
      toast('已备份到 ' + res.location);
      refreshStatus();
    } catch (e) {
      toast('备份失败：' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '立即备份';
    }
  });

  /* ---- 扫描当前网页：截图后打开「框选」窗口，只解码框住的那一块 ---- */
  $('scanPageBtn').addEventListener('click', async () => {
    const btn = $('scanPageBtn');
    btn.disabled = true;
    try {
      await send('qr.select');       // 截图 + 在当前页面盖一层浮层
      window.close();                // 弹窗让开，浮层才能被操作
    } catch (e) {
      toast('扫码失败：' + e.message);
      btn.disabled = false;
    }
  });

  $('importBack').addEventListener('click', () => { show('mainView'); startTicking(); });
  $('importBtn').addEventListener('click', async () => {
    const text = $('importText').value.trim();
    $('importErr').textContent = '';
    $('importResult').textContent = '';
    if (!text) return;
    try {
      const parsed = await send('scan.handle', { text });
      if (parsed.action === 'sync-join') {
        $('importErr').textContent = '这是同步配对码，请到设置页「端到端同步」中导入';
        return;
      }
      const res = await send('entry.import', { entries: parsed.entries, mode: 'merge' });
      $('importResult').textContent = `成功导入 ${parsed.entries.length} 条，当前共 ${res.total} 条。`;
      await reload();
      setTimeout(() => { show('mainView'); }, 900);
    } catch (e) {
      $('importErr').textContent = e.message;
    }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (!$('formView').hidden) { show('mainView'); startTicking(); }
      else if (!$('importView').hidden) { show('mainView'); startTicking(); }
      else if (!$('detailView').hidden) { state.detailId = null; show('mainView'); startTicking(); }
      else window.close();
    }
    if (ev.key === 'Enter' && ev.ctrlKey && !$('formView').hidden) {
      $('entryForm').requestSubmit();
    }
  });

  // pasting an otpauth / migration / entry QR payload jumps straight to import
  document.addEventListener('paste', (ev) => {
    const text = (ev.clipboardData || window.clipboardData).getData('text');
    if (/^(otpauth(-migration)?:\/\/|f2a-passkey:)/.test((text || '').trim())) {
      $('importText').value = text.trim();
      show('importView');
      $('importBtn').click();
    }
  });

  reload();
})();
