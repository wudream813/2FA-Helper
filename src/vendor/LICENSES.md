# Vendored third-party code

These files are checked into the repository unchanged (only minified in jsQR's
case) so the extension works offline with zero runtime dependencies. Both are
MIT licensed and are used unmodified in behaviour.

## jsqr.js — jsQR 1.4.0

QR code decoder. Used by the "扫码导入" feature and the options page.

- Source: https://github.com/cozmo/jsQR
- License: Apache-2.0 (see `LICENSE.jsqr`)
- Build in this repo: minified with terser 5 (`-c -m`), no code changes.
- Global exposed: `jsQR`.

## qrcode.js — qrcode-generator 1.4.4

QR code encoder. Used to render entry / sync-pairing QR codes into a canvas.

- Source: https://github.com/kazuhikoarase/qrcode-generator
- Copyright (c) 2009 Kazuhiko Arase
- License: MIT
- "QR Code" is a registered trademark of DENSO WAVE INCORPORATED.
- Global exposed: `qrcode`.
