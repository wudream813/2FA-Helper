/* 2FA Helper — in-page region picker for "scan this page".
   The background captures the visible viewport and sends the PNG back here; we
   cover the page with that frozen screenshot at 1:1, let the user drag a box,
   and ask the background to decode only that rectangle. No extra window. */
(function () {
  'use strict';
  const api = (typeof browser !== 'undefined' && browser.runtime) ? browser : (typeof chrome !== 'undefined' ? chrome : null);
  if (!api || !api.runtime || !api.runtime.onMessage) return;

  const HOST_ID = '__f2a_overlay_host__';
  let ui = null;      // { root, shot, sel, tip, box }
  let drag = null;    // { x0, y0 }
  let busy = false;

  function build(shot) {
    const root = document.createElement('div');
    root.id = HOST_ID;
    Object.assign(root.style, {
      position: 'fixed', inset: '0', zIndex: '2147483647',
      backgroundImage: 'url("' + shot + '")',
      backgroundSize: '100% 100%', backgroundRepeat: 'no-repeat',
      cursor: 'crosshair', touchAction: 'none',
    });

    const tip = document.createElement('div');
    tip.textContent = '拖动框住二维码 · 松手识别 · Esc 取消';
    Object.assign(tip.style, {
      position: 'absolute', left: '50%', top: '14px', transform: 'translateX(-50%)',
      background: 'rgba(15,23,32,.88)', color: '#fff', font: '500 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif',
      padding: '7px 14px', borderRadius: '999px', pointerEvents: 'none', whiteSpace: 'nowrap',
      boxShadow: '0 2px 10px rgba(0,0,0,.25)',
    });

    const sel = document.createElement('div');
    Object.assign(sel.style, {
      position: 'absolute', display: 'none', border: '2px solid #2dd4bf',
      background: 'rgba(45,212,191,.18)', boxShadow: '0 0 0 9999px rgba(8,14,20,.45)',
      pointerEvents: 'none', borderRadius: '2px',
    });

    root.append(tip, sel);
    (document.body || document.documentElement).appendChild(root);
    ui = { root, sel, tip, shot };
    document.documentElement.style.setProperty('overflow', 'hidden');
    return ui;
  }

  function teardown() {
    if (!ui) return;
    ui.root.remove();
    ui = null;
    drag = null;
    busy = false;
    document.documentElement.style.removeProperty('overflow');
  }

  function setTip(text) { if (ui) ui.tip.textContent = text; }

  function paint(rect) {
    const sel = ui.sel;
    if (!rect || rect.w < 2 || rect.h < 2) { sel.style.display = 'none'; return; }
    sel.style.display = 'block';
    sel.style.left = rect.x + 'px';
    sel.style.top = rect.y + 'px';
    sel.style.width = rect.w + 'px';
    sel.style.height = rect.h + 'px';
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

  async function crop(rect) {
    busy = true;
    setTip('识别中…');
    try {
      const res = await api.runtime.sendMessage({
        type: 'overlay.crop',
        rect,
        viewport: { w: window.innerWidth, h: window.innerHeight },
      });
      if (!res || res.ok === false) throw new Error((res && res.error) || '识别失败');
      const data = res.data || {};
      if (data.noQr) {
        setTip('这块区域没有二维码 · 再框一次或按 Esc 退出');
        busy = false;
        return;
      }
      if (data.needsOptions) {
        setTip(data.needsOptions);
        setTimeout(teardown, 2600);
        return;
      }
      setTip(`已导入 ${data.imported} 条${data.label ? '（' + data.label + '）' : ''} · 保管库共 ${data.total} 条`);
      setTimeout(teardown, 1200);
    } catch (e) {
      setTip('识别失败：' + e.message + ' · Esc 退出');
      busy = false;
    }
  }

  function onDown(ev) {
    if (busy) return;
    ev.preventDefault();
    ev.stopPropagation();
    drag = point(ev);
    paint(null);
  }

  function onMove(ev) {
    if (!drag) return;
    ev.preventDefault();
    const rect = normalize(drag, point(ev));
    paint(rect);
    setTip(`${Math.round(rect.w)} × ${Math.round(rect.h)} px`);
  }

  function onUp(ev) {
    if (!drag) return;
    ev.preventDefault();
    const rect = normalize(drag, point(ev));
    drag = null;
    paint(rect);
    if (rect.w < 8 || rect.h < 8) { // ignore accidental clicks
      paint(null);
      setTip('拖动框住二维码 · 松手识别 · Esc 取消');
      return;
    }
    crop(rect);
  }

  function onKey(ev) {
    if (ev.key === 'Escape') { ev.preventDefault(); teardown(); }
  }

  function open(shot) {
    teardown();
    build(shot);
    ui.root.addEventListener('mousedown', onDown, true);
    ui.root.addEventListener('mousemove', onMove, true);
    ui.root.addEventListener('mouseup', onUp, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', () => { /* keep overlay */ });
  }

  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'overlay.open') return undefined;
    try {
      open(msg.shot);
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
    return undefined;
  });

  // exposed for tests
  window.__f2aOverlay = { open, teardown, normalize, get state() { return ui; } };
})();
