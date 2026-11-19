/* ESM wrapper around the classic jsQR build.
   Chromium 的 MV3 service worker 有时拿不到 importScripts 的成果（不同版本/不同
   加载时机表现不一致），所以再提供一条 dynamic import() 的路：import() 在扩展的
   service worker 里对所有版本都可用，而且不需要 CSP 的 unsafe-eval。 */
import './jsqr.js';

const scope = typeof self !== 'undefined' ? self : globalThis;
const decoder = scope.jsQR;
if (typeof decoder !== 'function') throw new Error('vendor/jsqr.js 没有导出 jsQR');
export default decoder;
export const jsQR = decoder;
