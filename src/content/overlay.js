/* 2FA Helper — in-page QR picker (Authenticator-style).
   1. page turns translucent, user drags a box around the QR code (live page,
      not a frozen screenshot);
   2. the box is hidden, the background captures the viewport and decodes
      *only* that rectangle.
   If the page has exactly one readable QR the background imports it before we
   ever get here — so the common case is a single click. */
(function () {
  'use strict';
  const api = (typeof browser !== 'undefined' && browser.runtime) ? browser : (typeof chrome !== 'undefined' ? chrome : null);
  if (!api || !api.runtime || !api.runtime.onMessage) return;

  const HOST_ID = '__f2a_overlay_host__';
  const TOAST_ID = '__f2a_overlay_toast__';
  let ui = null;
  let drag = null;
  let busy = false;

  /* ---------------- toast (for the one-click fast path) ---------------- */

  function toast(text, bad) {
    const old = document.getElementById(TOAST_ID);
    if (old) old.remove();
    const el = document.createElement('div');
    el.id = TOAST_ID;
    el.textContent = text;
    Object.assign(el.style, {
      position: 'fixed', left: '50%', top: '18px', transform: 'translateX(-50%)',
      zIndex: '2147483647', maxWidth: '80vw',
      background: bad ? 'rgba(180,52,31,.95)' : 'rgba(15,23,32,.92)', color: '#fff',
      font: '500 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif',
      padding: '9px 16px', borderRadius: '999px', pointerEvents: 'none', whiteSpace: 'nowrap',
      boxShadow: '0 4px 14px rgba(0,0,0,.28)',
    });
    (document.body || document.documentElement).appendChild(el);
    setTimeout(() => el.remove(), bad ? 3200 : 2000);
  }

  /* ---------------- drag-to-select overlay ---------------- */

  function build() {
    const root = document.createElement('div');
    root.id = HOST_ID;
    Object.assign(root.style, {
      position: 'fixed', inset: '0', zIndex: '2147483646',
      background: 'rgba(12,18,26,.35)', cursor: 'crosshair', touchAction: 'none',
    });

    const tip = document.createElement('div');
    tip.textContent = '拖动框住二维码 · 松手识别 · Esc 取消';
    Object.assign(tip.style, {
      position: 'absolute', left: '50%', top: '14px', transform: 'translateX(-50%)',
      background: 'rgba(15,23,32,.9)', color: '#fff',
      font: '500 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif',
      padding: '7px 14px', borderRadius: '999px', pointerEvents: 'none', whiteSpace: 'nowrap',
      boxShadow: '0 2px 10px rgba(0,0,0,.25)',
    });

    const sel = document.createElement('div');
    Object.assign(sel.style, {
      position: 'absolute', display: 'none', border: '2px solid #2dd4bf',
      background: 'rgba(45,212,191,.12)', borderRadius: '2px',
      boxShadow: '0 0 0 9999px rgba(8,14,20,.18)', pointerEvents: 'none',
    });

    root.append(tip, sel);
    (document.body || document.documentElement).appendChild(root);
    ui = { root, sel, tip };
    return ui;
  }

  function teardown() {
    if (!ui) return;
    ui.root.remove();
    ui = null;
    drag = null;
    busy = false;
  }

  function setTip(text) { if (ui) ui.tip.textContent = text; }

  function paint(rect) {
    if (!ui) return;
    if (!rect || rect.w < 2 || rect.h < 2) { ui.sel.style.display = 'none'; return; }
    Object.assign(ui.sel.style, {
      display: 'block', left: rect.x + 'px', top: rect.y + 'px',
      width: rect.w + 'px', height: rect.h + 'px',
    });
  }

  function point(ev) {
    return {
      x: Math.max(0, Math.min(window.innerWidth, ev.clientX)),
      y: Math.max(0, Math.min(window.innerHeight, ev.clientY)),
    };
  }

  function normalize(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function crop(rect) {
    busy = true;
    setTip('识别中…');
    // hide the overlay *before* the background screenshots, otherwise the
    // green box ends up in the capture
    ui.root.style.visibility = 'hidden';
    await wait(60);
    try {
      const res = await api.runtime.sendMessage({
        type: 'overlay.crop',
        rect,
        viewport: { w: window.innerWidth, h: window.innerHeight },
      });
      if (!res || res.ok === false) throw new Error((res && res.error) || '识别失败');
      const data = res.data || {};
      teardown();
      if (data.noQr) return toast('这块区域没有二维码，再点一次 ▣ 试试', true);
      if (data.needsOptions) return toast(data.needsOptions, true);
      toast(`已导入 ${data.imported} 条${data.label ? '：' + data.label : ''} · 共 ${data.total} 条`);
    } catch (e) {
      teardown();
      toast('识别失败：' + e.message, true);
    }
  }

  function onDown(ev) {
    if (busy) return;
    ev.preventDefault();
    ev.stopPropagation();
    drag = point(ev);
    paint(null);
    setTip('松手即识别');
  }

  function onMove(ev) {
    if (!drag) return;
    ev.preventDefault();
    const rect = normalize(drag, point(ev));
    paint(rect);
    setTip(`${Math.round(rect.w)} × ${Math.round(rect.h)} px · 松手识别`);
  }

  function onUp(ev) {
    if (!drag) return;
    ev.preventDefault();
    const rect = normalize(drag, point(ev));
    drag = null;
    paint(rect);
    if (rect.w < 8 || rect.h < 8) { // accidental click
      paint(null);
      setTip('拖动框住二维码 · 松手识别 · Esc 取消');
      return;
    }
    crop(rect);
  }

  function onKey(ev) {
    if (ev.key === 'Escape') { ev.preventDefault(); teardown(); }
  }

  function open() {
    teardown();
    build();
    ui.root.addEventListener('mousedown', onDown, true);
    ui.root.addEventListener('mousemove', onMove, true);
    ui.root.addEventListener('mouseup', onUp, true);
    window.addEventListener('keydown', onKey, true);
  }

  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return undefined;
    if (msg.type === 'overlay.open') {
      open();
      sendResponse({ ok: true });
      return undefined;
    }
    if (msg.type === 'overlay.toast') {
      toast(msg.text || '', !!msg.bad);
      sendResponse({ ok: true });
      return undefined;
    }
    return undefined;
  });

  // exposed for tests
  window.__f2aOverlay = { open, teardown, normalize, toast, get state() { return ui; } };
})();
