#!/usr/bin/env node
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const WEB_FILES = [
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'icon.svg',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png',
  'vendor/ts-fsrs-5.4.2.js'
];

const TARGET_WEB_DIRS = [
  path.join(root, 'apps', 'desktop', 'web'),
  path.join(root, 'apps', 'android', 'app', 'src', 'main', 'assets', 'web')
];

for (const dir of TARGET_WEB_DIRS) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const rel of WEB_FILES) {
    const src = path.join(root, rel);
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

// Desktop icon
const desktopBuildDir = path.join(root, 'apps', 'desktop', 'build');
fs.mkdirSync(desktopBuildDir, { recursive: true });
fs.copyFileSync(path.join(root, 'icon-512.png'), path.join(desktopBuildDir, 'icon.png'));

// Android launcher icons
const androidResDir = path.join(root, 'apps', 'android', 'app', 'src', 'main', 'res');
const mipmapXhdpi = path.join(androidResDir, 'mipmap-xhdpi');
const mipmapXxxhdpi = path.join(androidResDir, 'mipmap-xxxhdpi');
fs.mkdirSync(mipmapXhdpi, { recursive: true });
fs.mkdirSync(mipmapXxxhdpi, { recursive: true });
fs.copyFileSync(path.join(root, 'icon-192.png'), path.join(mipmapXhdpi, 'ic_launcher.png'));
fs.copyFileSync(path.join(root, 'icon-512.png'), path.join(mipmapXxxhdpi, 'ic_launcher.png'));

const safeGit = (cmd) => {
  try { return execSync(cmd, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim(); }
  catch { return ''; }
};
const desktopPkg = JSON.parse(fs.readFileSync(path.join(root, 'apps', 'desktop', 'package.json'), 'utf8'));
const commit = process.env.WORDDRILL_BUILD_SHA || safeGit('git rev-parse HEAD');
const builtAt = process.env.WORDDRILL_BUILD_TIME || safeGit('git show -s --format=%cI HEAD') || new Date().toISOString();
const rawVer = process.env.WORDDRILL_VERSION || desktopPkg.version || '1.0.0';
const buildInfo = {
  version: String(rawVer).replace(/^v/i, ''),
  commit,
  shortCommit: commit ? commit.slice(0, 7) : '',
  builtAt
};

for (const dir of TARGET_WEB_DIRS) {
  fs.writeFileSync(path.join(dir, 'build-info.json'), JSON.stringify(buildInfo, null, 2));
}
fs.writeFileSync(path.join(root, 'apps', 'desktop', 'build-info.json'), JSON.stringify(buildInfo, null, 2));

console.log(`Synced ${WEB_FILES.length} web assets + build-info.json (${buildInfo.version} ${buildInfo.shortCommit}) to desktop and android bundles.`);
