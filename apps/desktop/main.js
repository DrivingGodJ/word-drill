const { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const WEB_DIR = path.resolve(__dirname, 'web');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'worddrill',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  }
]);

function getWordbooksDir() {
  const dir = path.join(app.getPath('documents'), 'WordDrill', 'wordbooks');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const shortBookId = (bookId) => String(bookId || '').replace(/^local:/, '');

function safeFilename(name) {
  const base = path.basename(String(name || 'wordbook.json')).replace(/[\\/:*?"<>|]/g, '-');
  return base.endsWith('.json') ? base : `${base}.json`;
}

async function writeBundleFile(bookId, fileName, content) {
  const dir = getWordbooksDir();
  const shortId = shortBookId(bookId);
  const targetName = safeFilename(fileName);
  const targetPath = path.join(dir, targetName);

  // If the user renamed the book, remove older file matching __<shortId>.json
  if (shortId) {
    const suffix = `__${shortId}.json`;
    const entries = await fsp.readdir(dir).catch(() => []);
    for (const entry of entries) {
      if (entry.endsWith(suffix) && entry !== targetName) {
        await fsp.unlink(path.join(dir, entry)).catch(() => {});
      }
    }
  }

  const tmpPath = path.join(dir, `.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  await fsp.writeFile(tmpPath, String(content || ''), 'utf8');
  await fsp.rename(tmpPath, targetPath);
  return { ok: true, path: targetPath };
}

async function deleteBundleFile(bookId) {
  const dir = getWordbooksDir();
  const shortId = shortBookId(bookId);
  if (!shortId) return { ok: true };
  const suffix = `__${shortId}.json`;
  const entries = await fsp.readdir(dir).catch(() => []);
  for (const entry of entries) {
    if (entry.endsWith(suffix)) {
      await fsp.unlink(path.join(dir, entry)).catch(() => {});
    }
  }
  return { ok: true };
}

async function listBundleFiles() {
  const dir = getWordbooksDir();
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const results = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('.')) continue;
    try {
      const content = await fsp.readFile(path.join(dir, entry.name), 'utf8');
      results.push({ name: entry.name, content });
    } catch {
      // ignore unreadable entry
    }
  }
  return results;
}

function registerProtocolHandler() {
  protocol.handle('worddrill', async (request) => {
    const url = new URL(request.url);
    let relPath = decodeURIComponent(url.pathname || '/');
    if (relPath === '/' || !relPath) relPath = '/index.html';
    const resolved = path.resolve(WEB_DIR, relPath.replace(/^\/+/, ''));
    if (resolved !== WEB_DIR && !resolved.startsWith(WEB_DIR + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      const data = await fsp.readFile(resolved);
      const ext = path.extname(resolved).toLowerCase();
      return new Response(data, {
        status: 200,
        headers: { 'content-type': MIME_TYPES[ext] || 'application/octet-stream' }
      });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 380,
    minHeight: 600,
    title: 'WordDrill · 背单词',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('worddrill://')) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  win.loadURL('worddrill://app/index.html');
}

function readBuildInfo() {
  for (const candidate of [
    path.join(__dirname, 'build-info.json'),
    path.join(WEB_DIR, 'build-info.json')
  ]) {
    try {
      return JSON.parse(fs.readFileSync(candidate, 'utf8'));
    } catch {
      // try next path
    }
  }
  return {};
}

function getAppInfo() {
  const meta = readBuildInfo();
  const commit = String(meta.commit || '');
  return {
    platform: process.platform === 'darwin' ? 'macos' : 'windows',
    arch: process.arch,
    version: String(meta.version || app.getVersion() || '1.0.0'),
    commit,
    shortCommit: String(meta.shortCommit || commit.slice(0, 7)),
    builtAt: String(meta.builtAt || '')
  };
}

async function fetchLatestReleaseMeta(token) {
  const verUrl = `https://github.com/DrivingGodJ/word-drill/releases/latest/download/version.json?t=${Date.now()}`;
  let lastErr = '';
  try {
    const res = await net.fetch(verUrl, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'WordDrill-Desktop' }
    });
    if (res.ok) return { ok: true, data: await res.json() };
    lastErr = `version.json (${res.status})`;
  } catch (err) {
    lastErr = err?.message || 'network error';
  }

  try {
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'WordDrill-Desktop'
    };
    if (token) headers.Authorization = `Bearer ${String(token).trim()}`;
    const apiRes = await net.fetch('https://api.github.com/repos/DrivingGodJ/word-drill/releases/latest', {
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
      headers
    });
    if (apiRes.ok) return { ok: true, data: await apiRes.json() };
    return { ok: false, message: `检查更新失败（GitHub ${apiRes.status}${lastErr ? ` / ${lastErr}` : ''}）` };
  } catch (err) {
    return { ok: false, message: `无法连接 GitHub（${err?.message || lastErr || '请检查网络或代理'}）` };
  }
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    const template = [
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'windowMenu' }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  } else {
    Menu.setApplicationMenu(null);
  }
  getWordbooksDir();
  registerProtocolHandler();

  ipcMain.handle('worddrill:get-app-info', () => getAppInfo());
  ipcMain.handle('worddrill:fetch-latest-release', (_, token) => fetchLatestReleaseMeta(token));
  ipcMain.handle('worddrill:get-dir', () => getWordbooksDir());
  ipcMain.handle('worddrill:open-dir', async () => {
    const dir = getWordbooksDir();
    const err = await shell.openPath(dir);
    return err ? { ok: false, path: dir, message: err } : { ok: true, path: dir };
  });
  ipcMain.handle('worddrill:write-bundle', (_, bookId, fileName, content) =>
    writeBundleFile(bookId, fileName, content)
  );
  ipcMain.handle('worddrill:delete-bundle', (_, bookId) => deleteBundleFile(bookId));
  ipcMain.handle('worddrill:list-bundles', () => listBundleFiles());
  ipcMain.handle('worddrill:save-export', async (event, suggestedName, content) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const defaultPath = path.join(getWordbooksDir(), safeFilename(suggestedName));
    const res = await dialog.showSaveDialog(win, {
      title: '导出词库文件',
      defaultPath,
      filters: [{ name: 'WordDrill 词库 (JSON)', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    await fsp.writeFile(res.filePath, String(content || ''), 'utf8');
    return { ok: true, path: res.filePath };
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
