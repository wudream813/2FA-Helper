/* 2FA Helper — vault envelope + AES-GCM/PBKDF2 crypto (classic script) */
(function (root) {
  'use strict';
  const F2A = (root.F2A = root.F2A || {});
  const subtle = root.crypto.subtle;

  const APP = '2FA Helper';
  const FORMAT = 'f2a-vault';
  const VERSION = 1;
  const DEFAULT_ITER = 250000;

  async function deriveKey(password, saltBytes, iterations = DEFAULT_ITER) {
    const base = await subtle.importKey('raw', F2A.utf8Encode(password), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
  }

  async function exportKey(key) {
    return F2A.bytesToB64(new Uint8Array(await subtle.exportKey('raw', key)));
  }

  async function importKey(b64) {
    return subtle.importKey('raw', F2A.b64ToBytes(b64), { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  }

  async function encrypt(key, obj) {
    const iv = F2A.randomBytes(12);
    const ct = await subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      key,
      F2A.utf8Encode(JSON.stringify(obj))
    );
    return { iv: F2A.bytesToB64(iv), ct: F2A.bytesToB64(new Uint8Array(ct)) };
  }

  async function decrypt(key, ivB64, ctB64) {
    const pt = await subtle.decrypt(
      { name: 'AES-GCM', iv: F2A.b64ToBytes(ivB64), tagLength: 128 },
      key,
      F2A.b64ToBytes(ctB64)
    );
    return JSON.parse(F2A.utf8Decode(new Uint8Array(pt)));
  }

  /**
   * Build a self-describing envelope around { entries, settings? }.
   * @param {object} data            payload to protect
   * @param {object} opts            { password }  — omit/empty for plaintext envelope
   */
  async function seal(data, opts = {}) {
    const meta = {
      entryCount: Array.isArray(data.entries) ? data.entries.length : 0,
    };
    const base = {
      app: APP,
      format: FORMAT,
      version: VERSION,
      createdAt: F2A.nowIso(),
      encrypted: !!opts.password,
    };

    if (!opts.password) {
      return Object.assign(base, { data, meta });
    }

    const iterations = opts.iterations || DEFAULT_ITER;
    const salt = F2A.randomBytes(16);
    const key = await deriveKey(opts.password, salt, iterations);
    const { iv, ct } = await encrypt(key, data);
    return Object.assign(base, {
      kdf: { algo: 'PBKDF2-SHA256', iterations, salt: F2A.bytesToB64(salt) },
      cipher: { algo: 'AES-GCM-256', iv },
      payload: ct,
      meta,
    });
  }

  /** Returns { encrypted, data, keyB64 } — keyB64 lets the caller cache the derived key. */
  async function open(envelope, password) {
    if (!envelope || envelope.format !== FORMAT) throw new Error('文件格式无法识别');
    if (!envelope.encrypted) return { encrypted: false, data: envelope.data || {}, keyB64: null };
    if (!password) throw new Error('该保管库已加密，需要主密码');

    const iter = (envelope.kdf && envelope.kdf.iterations) || DEFAULT_ITER;
    const salt = F2A.b64ToBytes(envelope.kdf.salt);
    const key = await deriveKey(password, salt, iter);
    let data;
    try {
      data = await decrypt(key, envelope.cipher.iv, envelope.payload);
    } catch (e) {
      throw new Error('主密码不正确，或备份文件已损坏');
    }
    return { encrypted: true, data, keyB64: await exportKey(key) };
  }

  /** Re-open an encrypted envelope with an already derived raw key (no PBKDF2 cost). */
  async function openWithKey(envelope, keyB64) {
    if (!envelope.encrypted) return envelope.data || {};
    const key = await importKey(keyB64);
    return decrypt(key, envelope.cipher.iv, envelope.payload);
  }

  Object.assign(F2A, {
    vaultCrypto: {
      APP, FORMAT, VERSION, DEFAULT_ITER,
      deriveKey, exportKey, importKey, encrypt, decrypt, seal, open, openWithKey,
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
