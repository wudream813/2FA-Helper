/* 2FA Helper — TOTP / HOTP engine + otpauth parsing (classic script) */
(function (root) {
  'use strict';
  const F2A = (root.F2A = root.F2A || {});
  const subtle = root.crypto.subtle;

  const ALGOS = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };

  function normalizeAlgo(a) {
    const k = String(a || 'SHA1').toUpperCase().replace('-', '');
    if (k === 'SHA256') return 'SHA256';
    if (k === 'SHA512') return 'SHA512';
    return 'SHA1';
  }

  async function hmac(algo, keyBytes, msgBytes) {
    const key = await subtle.importKey(
      'raw', keyBytes, { name: 'HMAC', hash: { name: ALGOS[algo] } }, false, ['sign']
    );
    return new Uint8Array(await subtle.sign('HMAC', key, msgBytes));
  }

  function counterToBytes(counter) {
    const buf = new Uint8Array(8);
    let value = BigInt(counter);
    for (let i = 7; i >= 0; i--) {
      buf[i] = Number(value & 0xffn);
      value >>= 8n;
    }
    return buf;
  }

  async function hotp({ secretBytes, counter, digits = 6, algorithm = 'SHA1' }) {
    const algo = normalizeAlgo(algorithm);
    const mac = await hmac(algo, secretBytes, counterToBytes(counter));
    const offset = mac[mac.length - 1] & 0x0f;
    const bin = ((mac[offset] & 0x7f) << 24) |
                ((mac[offset + 1] & 0xff) << 16) |
                ((mac[offset + 2] & 0xff) << 8) |
                (mac[offset + 3] & 0xff);
    const mod = 10 ** Number(digits || 6);
    return String(bin % mod).padStart(Number(digits || 6), '0');
  }

  /**
   * Compute a code for an entry.
   * @returns {{code:string, remaining:number, period:number, progress:number, counter:number}}
   */
  async function generate(entry, atMs = Date.now()) {
    const digits = Number(entry.digits || 6);
    const algorithm = normalizeAlgo(entry.algorithm);
    const secretBytes = entry._secretBytes || F2A.b32decode(entry.secret);
    const isHotp = (entry.type || 'totp').toLowerCase() === 'hotp';
    const period = Number(entry.period || 30);

    if (isHotp) {
      const counter = Number(entry.counter || 0);
      const code = await hotp({ secretBytes, counter, digits, algorithm });
      return { code, remaining: period, period, progress: 1, counter, type: 'hotp' };
    }

    const counter = Math.floor(atMs / 1000 / period);
    const code = await hotp({ secretBytes, counter, digits, algorithm });
    const elapsed = (atMs / 1000) % period;
    const remaining = Math.ceil(period - elapsed);
    return { code, remaining, period, progress: 1 - elapsed / period, counter, type: 'totp' };
  }

  /* ---------- otpauth:// parsing ---------- */
  function parseOtpauth(uri) {
    const m = /^otpauth:\/\/(totp|hotp)\/([^?]*)\??(.*)$/i.exec(String(uri).trim());
    if (!m) throw new Error('不是有效的 otpauth:// 链接');
    const type = m[1].toLowerCase();
    const labelRaw = decodeURIComponent(m[2] || '');
    const params = new URLSearchParams(m[3] || '');

    let issuer = params.get('issuer') || '';
    let account = labelRaw;
    const colon = labelRaw.indexOf(':');
    if (colon !== -1) {
      if (!issuer) issuer = labelRaw.slice(0, colon).trim();
      account = labelRaw.slice(colon + 1).trim();
    }
    const secret = (params.get('secret') || '').replace(/\s/g, '');
    if (!secret) throw new Error('otpauth 链接缺少 secret 参数');

    return {
      type,
      issuer: issuer.trim(),
      account: account.trim(),
      secret,
      digits: F2A.clamp(params.get('digits') || 6, 6, 8),
      period: F2A.clamp(params.get('period') || 30, 10, 300),
      algorithm: normalizeAlgo(params.get('algorithm')),
      counter: Number(params.get('counter') || 0) || 0,
    };
  }

  function toOtpauth(entry) {
    const type = (entry.type || 'totp').toLowerCase();
    const issuer = entry.issuer || '';
    const account = entry.account || 'account';
    const label = issuer ? `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}` : encodeURIComponent(account);
    const p = new URLSearchParams();
    p.set('secret', (entry.secret || '').replace(/\s/g, '').toUpperCase());
    if (issuer) p.set('issuer', issuer);
    if (Number(entry.digits) !== 6) p.set('digits', String(entry.digits));
    if (Number(entry.period) !== 30 && type === 'totp') p.set('period', String(entry.period));
    if ((entry.algorithm || 'SHA1') !== 'SHA1') p.set('algorithm', entry.algorithm);
    if (type === 'hotp') p.set('counter', String(entry.counter || 0));
    return `otpauth://${type}/${label}?${p.toString()}`;
  }

  /* ---------- Google Authenticator export (otpauth-migration) ---------- */
  function readVarint(buf, pos) {
    let result = 0n, shift = 0n, byte;
    do {
      if (pos.i >= buf.length) throw new Error('protobuf 截断');
      byte = buf[pos.i++];
      result |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
    } while (byte & 0x80);
    return result;
  }

  function parseMigration(uri) {
    const m = /^otpauth-migration:\/\/offline\?data=(.+)$/i.exec(String(uri).trim());
    if (!m) throw new Error('不是有效的 otpauth-migration:// 链接');
    let b64 = decodeURIComponent(m[1]).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const buf = F2A.b64ToBytes(b64);

    const out = [];
    const pos = { i: 0 };
    const ALGO_MAP = { 1: 'SHA1', 2: 'SHA256', 3: 'SHA512' };
    const DIGIT_MAP = { 1: 6, 2: 8 };

    while (pos.i < buf.length) {
      const key = Number(readVarint(buf, pos));
      const field = key >> 3;
      const wire = key & 7;
      if (wire === 2) {
        const len = Number(readVarint(buf, pos));
        const end = pos.i + len;
        if (field === 1) {
          // nested OtpParameters
          const inner = { i: pos.i };
          const item = { type: 'totp', algorithm: 'SHA1', digits: 6, period: 30, counter: 0, issuer: '', account: '', secret: '' };
          while (inner.i < end) {
            const k2 = Number(readVarint(buf, inner));
            const f2 = k2 >> 3;
            const w2 = k2 & 7;
            if (w2 === 2) {
              const l2 = Number(readVarint(buf, inner));
              const chunk = buf.subarray(inner.i, inner.i + l2);
              inner.i += l2;
              if (f2 === 1) item.secret = F2A.b32encode(chunk);
              else if (f2 === 2) item.account = new TextDecoder().decode(chunk);
              else if (f2 === 3) item.issuer = new TextDecoder().decode(chunk);
            } else if (w2 === 0) {
              const v = Number(readVarint(buf, inner));
              if (f2 === 4) item.algorithm = ALGO_MAP[v] || 'SHA1';
              else if (f2 === 5) item.digits = DIGIT_MAP[v] || 6;
              else if (f2 === 6) item.type = v === 1 ? 'hotp' : 'totp';
              else if (f2 === 7) item.counter = v;
            } else if (w2 === 5) inner.i += 4;
            else if (w2 === 1) inner.i += 8;
            else break;
          }
          if (item.secret) {
            if (!item.issuer && item.account.includes(':')) {
              const idx = item.account.indexOf(':');
              item.issuer = item.account.slice(0, idx).trim();
              item.account = item.account.slice(idx + 1).trim();
            }
            out.push(item);
          }
          pos.i = end;
        } else {
          pos.i = end;
        }
      } else if (wire === 0) {
        readVarint(buf, pos);
      } else if (wire === 5) pos.i += 4;
      else if (wire === 1) pos.i += 8;
      else break;
    }
    if (!out.length) throw new Error('未解析出任何账户');
    return out;
  }

  /* ---------- generic import from JSON (2FA Helper / Aegis / andOTP-ish) ---------- */
  function importFromJson(text) {
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : (data.entries || data.accounts || data.tokens || data.items || null);
    if (!Array.isArray(list)) throw new Error('JSON 结构无法识别（需要 entries 数组）');
    return list.map((it) => {
      // passkey records carry their payload in `passkey` (or inline)
      if (it.kind === 'passkey' || (it.passkey && !it.secret)) {
        const pk = it.passkey || it;
        return {
          kind: 'passkey',
          issuer: it.issuer || pk.rpName || pk.rpId || '',
          account: it.account || pk.userName || '',
          urls: it.urls || (pk.rpId ? [pk.rpId] : []),
          note: it.note || pk.note || '',
          passkey: pk,
        };
      }
      return {
        kind: 'otp',
        type: it.type === 'hotp' ? 'hotp' : 'totp',
        issuer: it.issuer || it.label || '',
        account: it.account || it.name || it.username || it.email || '',
        secret: String(it.secret || (it.info && it.info.secret) || '').replace(/\s/g, ''),
        digits: Number(it.digits || 6),
        period: Number(it.period || 30),
        algorithm: normalizeAlgo(it.algorithm),
        counter: Number(it.counter || 0),
        urls: it.urls || it.domain ? [].concat(it.urls || it.domain) : [],
        note: it.note || '',
      };
    }).filter((it) => (it.kind === 'passkey' ? !!(it.passkey && it.passkey.rpId) : !!it.secret));
  }

  Object.assign(F2A, {
    totp: { generate, hotp, normalizeAlgo },
    otpauth: { parse: parseOtpauth, toUri: toOtpauth, parseMigration, importFromJson },
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
