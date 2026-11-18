/* 2FA Helper — shared utilities (classic script, works in SW / page / background page) */
(function (root) {
  'use strict';
  const F2A = (root.F2A = root.F2A || {});
  const api = root.browser || root.chrome;

  F2A.api = api;
  F2A.isFirefox = !!(root.browser && root.browser.runtime && root.browser.runtime.getBrowserInfo);

  /* ---------- base32 ---------- */
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  function b32decode(input) {
    if (!input) return new Uint8Array(0);
    let str = String(input).toUpperCase().replace(/[\s\-_]/g, '').replace(/=+$/, '');
    str = str.replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B');
    let bits = 0, value = 0;
    const out = [];
    for (const ch of str) {
      const idx = B32.indexOf(ch);
      if (idx === -1) throw new Error('无效的 Base32 字符: ' + ch);
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        out.push((value >>> bits) & 0xff);
      }
    }
    return new Uint8Array(out);
  }

  function b32encode(bytes) {
    let bits = 0, value = 0, out = '';
    for (const b of bytes) {
      value = (value << 8) | b;
      bits += 8;
      while (bits >= 5) {
        bits -= 5;
        out += B32[(value >>> bits) & 31];
      }
    }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return out;
  }

  /* ---------- base64 / bytes ---------- */
  function bytesToB64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return root.btoa(bin);
  }

  function b64ToBytes(b64) {
    const bin = root.atob(String(b64).replace(/\s/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function utf8Encode(str) { return enc.encode(str); }
  function utf8Decode(bytes) { return dec.decode(bytes); }

  function concatBytes(...arrs) {
    let len = 0;
    for (const a of arrs) len += a.length;
    const out = new Uint8Array(len);
    let off = 0;
    for (const a of arrs) { out.set(a, off); off += a.length; }
    return out;
  }

  function randomBytes(n) {
    const b = new Uint8Array(n);
    root.crypto.getRandomValues(b);
    return b;
  }

  /* ---------- misc ---------- */
  function uid() {
    return [...randomBytes(9)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function nowIso() { return new Date().toISOString(); }

  function clamp(n, min, max) { return Math.min(max, Math.max(min, Number(n) || 0)); }

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function timeAgo(iso) {
    if (!iso) return '从未';
    const diff = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(diff)) return '从未';
    const m = Math.floor(diff / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    const d = Math.floor(h / 24);
    if (d < 30) return d + ' 天前';
    return new Date(iso).toLocaleDateString();
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function humanSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function debounce(fn, ms) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  /* conservative domain matcher: entry host === page host or a suffix of it */
  function hostMatches(pageHost, entryHost) {
    if (!pageHost || !entryHost) return false;
    const a = pageHost.toLowerCase().replace(/^www\./, '');
    const b = String(entryHost).toLowerCase().replace(/^www\./, '');
    if (!a || !b) return false;
    return a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
  }

  function hostFromUrl(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
  }

  /* Promise wrapper that never throws */
  async function safe(fn, fallback) {
    try { return await fn(); } catch (e) { return fallback; }
  }

  Object.assign(F2A, {
    b32decode, b32encode, bytesToB64, b64ToBytes, utf8Encode, utf8Decode,
    concatBytes, randomBytes, uid, nowIso, clamp, escapeHtml, timeAgo,
    fmtDateTime, humanSize, debounce, hostMatches, hostFromUrl, safe,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
