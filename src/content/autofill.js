/* 2FA Helper — autofill helper for login pages.
   Injects nothing until an OTP field is focused; UI lives in a shadow root so
   the host page's CSS can never touch it. Secrets never leave the background. */
(function () {
  'use strict';
  if (window.__f2aAutofillLoaded) return;
  window.__f2aAutofillLoaded = true;

  const HOST_ID = '__f2a_autofill_host';
  const api = globalThis.browser || globalThis.chrome;
  let host = null;
  let root = null;
  let chip = null;
  let currentInput = null;
  let matches = [];
  let hideTimer = null;

  const OTP_HINT = /(one[-_ ]?time|otp|totp|2fa|mfa|auth.?code|verif(y|ication).?code|security.?code|sms.?code|动态码|验证码|校验码|双重验证)/i;

  // promise form works in both Chrome (MV3) and Firefox (browser.* has no callback form)
  async function send(type, payload = {}) {
    try {
      const res = await api.runtime.sendMessage(Object.assign({ type }, payload));
      if (!res || !res.ok) return null;
      return res.data;
    } catch (e) {
      return null;
    }
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 8) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
  }

  function looksLikeOtp(input) {
    if (!input || input.disabled || input.readOnly) return false;
    if (input.type && !['text', 'tel', 'number', 'password', ''].includes(input.type)) return false;
    if (input.autocomplete === 'one-time-code') return true;
    if (input.maxLength === 6 || input.maxLength === 7 || input.maxLength === 8) {
      if (input.inputMode === 'numeric' || input.type === 'tel' || input.type === 'number') return true;
    }
    const hay = [input.name, input.id, input.getAttribute('aria-label'), input.placeholder, input.className]
      .filter(Boolean).join(' ');
    if (OTP_HINT.test(hay)) return true;
    // 6-8 length numeric input sitting near a "code" label
    if ((input.inputMode === 'numeric' || input.pattern === '\\d*') && OTP_HINT.test(
      (input.closest('form') || document.body).innerText.slice(0, 4000))) {
      return true;
    }
    return false;
  }

  function pickInput(target) {
    if (target && (target.tagName === 'INPUT') && looksLikeOtp(target)) return target;
    const focused = document.activeElement;
    if (focused && focused.tagName === 'INPUT' && looksLikeOtp(focused)) return focused;
    return null;
  }

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = HOST_ID;
      host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;';
      (document.body || document.documentElement).appendChild(host);
    }
    root = host.shadowRoot || host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .chip {
          position: fixed;
          display: flex; align-items: center; gap: 7px;
          font: 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
          background: #12211d; color: #eaf6f2;
          border: 1px solid #2c4a42;
          border-radius: 9px;
          padding: 6px 10px;
          box-shadow: 0 6px 20px rgba(0,0,0,.28);
          cursor: pointer;
          user-select: none;
          opacity: 0;
          transform: translateY(4px);
          transition: opacity .12s, transform .12s;
          pointer-events: none;
          max-width: 260px;
        }
        .chip.show { opacity: 1; transform: translateY(0); pointer-events: auto; }
        .chip .k {
          font-family: ui-monospace, Menlo, Consolas, monospace;
          font-weight: 600; letter-spacing: .5px; color: #6fe0bd;
        }
        .chip .t { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: .8; }
        .chip.locked .k { color: #ffcf7a; }
      </style>
      <div class="chip" id="chip"><span class="k">2FA</span><span class="t"></span></div>
    `;
    chip = root.getElementById('chip');
    chip.addEventListener('mousedown', (ev) => ev.preventDefault());
    chip.addEventListener('click', onChipClick);
  }

  function position(input) {
    if (!chip || !input) return;
    const r = input.getBoundingClientRect();
    const top = Math.min(window.innerHeight - 40, r.bottom + 6);
    const left = Math.max(6, Math.min(window.innerWidth - 240, r.left));
    chip.style.top = top + 'px';
    chip.style.left = left + 'px';
  }

  function hide() {
    if (chip) chip.classList.remove('show');
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 220);
  }

  let lastCode = null;

  async function onChipClick() {
    if (!currentInput) return;
    if (!matches.length) {
      hide();
      return;
    }
    const entry = matches[0];
    const res = await send('autofill.code', { id: entry.id });
    if (!res || !res.code || !res.code.code) {
      showToast('无法获取验证码，请先在扩展中解锁');
      return;
    }
    lastCode = res.code.code;
    fill(currentInput, res.code.code);
    hide();
    showToast('已填入 ' + entry.issuer);
  }

  function fill(input, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    input.focus();
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: value.slice(-1) }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: value.slice(-1) }));
    // some flows want Enter pressed
    if (input.form) {
      const submit = input.form.querySelector('button[type="submit"],input[type="submit"]');
      if (submit && window.__f2aEnterSubmit) submit.click();
    }
  }

  function showToast(msg) {
    ensureHost();
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#12211d;color:#eaf6f2;font:12px/1.3 -apple-system,sans-serif;padding:8px 14px;border-radius:20px;box-shadow:0 6px 20px rgba(0,0,0,.3);z-index:2147483647;';
    root.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }

  async function refresh(input) {
    currentInput = input;
    if (!input) { hide(); return; }
    const res = await send('autofill.match', { host: location.hostname });
    if (!res) { hide(); return; }
    if (res.limited && !res.matches.length) { hide(); return; }
    matches = res.matches || [];
    ensureHost();
    const t = chip.querySelector('.t');
    const k = chip.querySelector('.k');
    if (res.locked) {
      chip.classList.add('locked');
      k.textContent = '🔒';
      t.textContent = matches.length ? '解锁后填充（' + (matches[0].issuer || '账户') + '）' : '打开扩展解锁';
    } else if (matches.length) {
      chip.classList.remove('locked');
      k.textContent = '2FA';
      t.textContent = matches.length === 1
        ? '填充 ' + (matches[0].issuer || matches[0].account)
        : `填充验证码（${matches.length} 个账户）`;
    } else {
      hide();
      return;
    }
    position(input);
    chip.classList.add('show');
  }

  document.addEventListener('focusin', (ev) => {
    const input = pickInput(ev.target);
    if (input) {
      clearTimeout(hideTimer);
      refresh(input);
    } else if (chip) {
      scheduleHide();
    }
  }, true);

  document.addEventListener('focusout', () => scheduleHide(), true);
  window.addEventListener('scroll', () => { if (currentInput) position(currentInput); }, { passive: true, capture: true });
  window.addEventListener('resize', () => { if (currentInput) position(currentInput); }, { passive: true });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') hide(); }, true);
})();
