#!/usr/bin/env node
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

console.log(`Synced ${WEB_FILES.length} web assets to desktop and android bundles.`);
