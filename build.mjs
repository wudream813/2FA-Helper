#!/usr/bin/env node
/**
 * 2FA Helper build script
 *   src/  ->  release/chromium | release/edge | release/firefox  (+ packaged .zip)
 *
 * Chromium and Edge share the same MV3 package; Firefox gets its own manifest
 * (background scripts instead of a service worker, optional_permissions instead
 * of optional_host_permissions, gecko id).
 */
import { cp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'release');

const TARGETS = [
  { dir: 'chromium', manifest: 'manifest.chromium.json', zip: '2fa-helper-chromium' },
  { dir: 'edge', manifest: 'manifest.chromium.json', zip: '2fa-helper-edge' },
  { dir: 'firefox', manifest: 'manifest.firefox.json', zip: '2fa-helper-firefox' },
];

const SKIP = new Set(['manifest.chromium.json', 'manifest.firefox.json']);

async function main() {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;
  await rm(DIST, { recursive: true, force: true });

  for (const target of TARGETS) {
    const outDir = path.join(DIST, target.dir);
    await mkdir(outDir, { recursive: true });
    await cp(SRC, outDir, {
      recursive: true,
      filter: (src) => {
        const base = path.basename(src);
        return !SKIP.has(base);
      },
    });

    const manifest = JSON.parse(await readFile(path.join(SRC, target.manifest), 'utf8'));
    if (manifest.version !== version) {
      throw new Error(`${target.manifest} version ${manifest.version} != package.json ${version}`);
    }
    await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

    // sanity: every file referenced by the manifest must exist
    const refs = [
      manifest.background?.service_worker,
      ...(manifest.background?.scripts || []),
      manifest.options_ui?.page,
      manifest.action?.default_popup,
      ...Object.values(manifest.icons || {}),
      ...Object.values(manifest.action?.default_icon || {}),
      ...(manifest.content_scripts || []).flatMap((cs) => [...(cs.js || []), ...(cs.css || [])]),
    ].filter(Boolean);
    for (const ref of refs) {
      await stat(path.join(outDir, ref)).catch(() => {
        throw new Error(`[${target.dir}] manifest 引用了不存在的文件: ${ref}`);
      });
    }

    // Firefox loads libs through manifest.background.scripts — make sure none is forgotten
    if (manifest.background && manifest.background.scripts) {
      const bgSource = await readFile(path.join(outDir, 'background.js'), 'utf8');
      const libMatch = /const LIB = \[([^\]]+)\]/.exec(bgSource);
      if (libMatch) {
        const libs = libMatch[1].split(',').map((x) => x.trim().replace(/['"]/g, '')).filter(Boolean);
        const missing = libs.filter((lib) => !manifest.background.scripts.includes(lib));
        if (missing.length) throw new Error(`[${target.dir}] manifest.background.scripts 缺少: ${missing.join(', ')}`);
      }
    }

    const zipName = `${target.zip}-${version}.zip`;
    execFileSync('zip', ['-qr', '-X', path.join(DIST, zipName), '.'], { cwd: outDir });
    const size = (await stat(path.join(DIST, zipName))).size;
    console.log(`✓ ${target.dir.padEnd(9)} → release/${zipName}  (${(size / 1024).toFixed(1)} KB, ${refs.length} manifest refs ok)`);
  }

  console.log('\n构建完成。加载方式：chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选择 release/chromium');
  console.log('               edge://extensions → 加载解压缩的扩展 → 选择 release/edge');
  console.log('               about:debugging → 临时载入附加组件 → 选择 release/firefox/manifest.json');
}

main().catch((e) => {
  console.error('✗ 构建失败:', e.message);
  process.exit(1);
});
