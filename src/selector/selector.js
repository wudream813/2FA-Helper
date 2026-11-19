/* 2FA Helper — region picker for "scan the current page".
   The background page captures the visible tab and stashes the PNG in
   storage.session; this window shows it at native resolution, lets the user
   drag a box, crops exactly those pixels and decodes just that region. */
(function () {
  'use strict';
  const F2A = globalThis.F2A;
  const api = F2A.api;
  const $ = (id) => document.getElementById(id);

  const state = { img: null, rect: null, dragging: false, start: null, busy: false, done: false };

  function send(type, payload = {}) {
    return api.runtime.sendMessage(Object.assign({ type }, payload)).then((res) => {
      if (!res) throw new Error('后台无响应');
      if (!res.ok) throw new Error(res.error || '未知错误');
      return res.data;
    });
  }

  function status(text) { $('status').textContent = text; }
  function showError(msg) {
    $('err').textContent = msg;
    $('err').hidden = false;
  }
  function clearError() { $('err').hidden = true; $('err').textContent = ''; }
  function showResult(msg) {
    $('result').textContent = msg;
    $('result').hidden = false;
  }

  /** Normalise a drag (any direction) into {x, y, w, h} in image pixel space. */
  function normalizeRect(a, b) {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  }

  function paintSel(rect) {
    const sel = $('sel');
    if (!rect || rect.w < 2 || rect.h < 2) { sel.hidden = true; return; }
    sel.hidden = false;
    sel.style.left = rect.x + 'px';
    sel.style.top = rect.y + 'px';
    sel.style.width = rect.w + 'px';
    sel.style.height = rect.h + 'px';
  }

  function pointInImage(ev) {
    const box = $('shot').getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(box.width, ev.clientX - box.left)),
      y: Math.max(0, Math.min(box.height, ev.clientY - box.top)),
    };
  }

  /* ---------------- decode ---------------- */

  async function decodeRect(rect) {
    if (state.busy) return;
    state.busy = true;
    clearError();
    status('识别中…');
    try {
      // The <img> is rendered 1:1 with the screenshot, so selection coordinates
      // are already in the source's pixel space — no scaling maths needed.
      const imageData = F2A.qr.cropImageData(state.img, rect);
      const text = F2A.qr.decodeImageData(imageData);
      if (!text) {
        status('没识别到二维码');
        showError('这块区域里没有识别到二维码。试着框得再紧一点，或者用「整张图识别」。');
        return;
      }
      await handleText(text);
    } catch (e) {
      status('出错');
      showError(e.message);
    } finally {
      state.busy = false;
    }
  }

  async function handleText(text) {
    const parsed = await send('scan.handle', { text });
    if (parsed.action === 'sync-join') {
      showError('这是同步配对码，请到设置页「端到端同步」中导入。');
      status('已识别，但不是 2FA 条目');
      return;
    }
    if (parsed.action === 'restore') {
      showError('这是加密备份文件，请到设置页的扫码导入里恢复。');
      status('已识别，但不是 2FA 条目');
      return;
    }
    const res = await send('entry.import', { entries: parsed.entries, mode: 'merge' });
    state.done = true;
    const names = parsed.entries.slice(0, 3).map((e) => e.issuer || e.account || '条目').join('、');
    showResult(`已导入 ${parsed.entries.length} 条（${names}${parsed.entries.length > 3 ? '…' : ''}），保管库共 ${res.total} 条。窗口即将关闭。`);
    status('完成');
    $('wholeBtn').disabled = true;
    setTimeout(() => { try { window.close(); } catch (e) { /* ignore */ } }, 1300);
  }

  /* ---------------- drag selection ---------------- */

  function onDown(ev) {
    if (state.busy || state.done) return;
    ev.preventDefault();
    state.dragging = true;
    state.start = pointInImage(ev);
    state.rect = null;
    paintSel(null);
    clearError();
    $('stage').setPointerCapture?.(ev.pointerId);
  }

  function onMove(ev) {
    if (!state.dragging) return;
    const p = pointInImage(ev);
    state.rect = normalizeRect(state.start, p);
    paintSel(state.rect);
    const r = state.rect;
    status(r.w < 2 || r.h < 2 ? '拖动框选二维码' : `${Math.round(r.w)} × ${Math.round(r.h)} px`);
  }

  function onUp(ev) {
    if (!state.dragging) return;
    state.dragging = false;
    const p = pointInImage(ev);
    const rect = normalizeRect(state.start, p);
    state.rect = rect;
    paintSel(rect);
    if (rect.w < 8 || rect.h < 8) { // too small to be a QR — ignore
      state.rect = null;
      paintSel(null);
      status('准备中…');
      return;
    }
    decodeRect(rect);
  }

  /* ---------------- boot ---------------- */

  async function boot() {
    const stage = $('stage');
    stage.addEventListener('pointerdown', onDown);
    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerup', onUp);
    stage.addEventListener('pointercancel', () => { state.dragging = false; });

    $('cancelBtn').addEventListener('click', () => window.close());
    $('wholeBtn').addEventListener('click', async () => {
      if (state.busy || state.done) return;
      const img = state.img;
      if (!img) return;
      await decodeRect({ x: 0, y: 0, w: img.naturalWidth || img.width, h: img.naturalHeight || img.height });
    });

    let shot = '';
    try {
      const st = await api.storage.session.get('qrShot');
      shot = st && st.qrShot;
    } catch (e) { /* older browsers */ }
    if (!shot) {
      const st = await api.storage.local.get('qrShot').catch(() => ({}));
      shot = st && st.qrShot;
    }
    if (!shot) {
      status('没有截图');
      showError('没有拿到网页截图。请回到扩展弹窗，重新点一次 ▣。');
      return;
    }

    const img = $('shot');
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('截图无法解析'));
      img.src = shot;
    }).catch((e) => { showError(e.message); });
    state.img = img;
    try { await api.storage.session.remove('qrShot'); } catch (e) { /* ignore */ }
    try { await api.storage.local.remove('qrShot'); } catch (e) { /* ignore */ }
    if (img.naturalWidth) status(`截图 ${img.naturalWidth} × ${img.naturalHeight}，拖动框选二维码`);
    else status('拖动框选二维码');
  }

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') window.close();
  });

  // exposed for the automated tests
  globalThis.__selector = { normalizeRect, decodeRect, handleText, state };

  boot();
})();
