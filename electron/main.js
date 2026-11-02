'use strict';
/**
 * CIKE — Electron shell.
 * Main process starts the local backend (Koa API + profile/browser manager)
 * and hosts the management UI, which talks to the same Local API over HTTP.
 */
const { app, BrowserWindow, ipcMain, shell, session, safeStorage, dialog, clipboard, Menu } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const { startBackend, DATA_DIR } = require('../src/server');
const { chromiumStatus, downloadChromium, executableMarker } = require('./chromium');

let backend = null;
let mainWindow = null;
const uiFile = path.join(__dirname, 'renderer', 'index.html');
const uiURL = pathToFileURL(uiFile).href;
if (process.env.LFB_DATA) app.setPath('userData', path.join(DATA_DIR, 'desktop'));
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); } });
function trusted(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || event.senderFrame.url !== uiURL) throw new Error('Untrusted IPC sender');
}
ipcMain.on('connection-info', event => {
  try { trusted(event); event.returnValue = { apiBase: backend.url, token: backend.token }; }
  catch { event.returnValue = {}; }
});

// If Chromium was downloaded before, point the backend at it.
function applyChromiumEnv() {
  try {
    const exe = fs.readFileSync(executableMarker(DATA_DIR), 'utf8').trim();
    if (exe) process.env.LFB_CHROMIUM_EXECUTABLE = exe;
  } catch { /* not downloaded yet */ }
}

// The stock Electron menu is English (File / Edit / View / Window).
// Build the whole menu in Chinese instead, with labels overriding the
// roles so the actions stay native but the text is always Chinese.
function showAbout() {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '关于 CIKE',
    message: `CIKE ${app.getVersion()}`,
    detail: '本地多环境浏览器 · 独立会话 · 代理管理 · 自动化 API\nWindows 适配版（基于 chainfix/cike 的 fork）',
    buttons: ['确定'],
  }).catch(() => {});
}

function buildApplicationMenu() {
  const isMac = process.platform === 'darwin';
  const template = [];
  if (isMac) {
    template.push({
      label: 'CIKE',
      submenu: [
        { label: '关于 CIKE', click: showAbout },
        { type: 'separator' },
        { label: '服务', role: 'services' },
        { type: 'separator' },
        { label: '隐藏 CIKE', role: 'hide' },
        { label: '隐藏其他', role: 'hideOthers' },
        { label: '显示全部', role: 'unhide' },
        { type: 'separator' },
        { label: '退出 CIKE', role: 'quit' },
      ],
    });
  }
  template.push(
    {
      label: '文件',
      submenu: [
        { label: '打开数据目录', click: () => { if (backend) shell.openPath(backend.dataDir); } },
        { type: 'separator' },
        ...(isMac ? [] : [{ label: '退出', role: 'quit', accelerator: 'Ctrl+Q' }]),
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '删除', role: 'delete' },
        { type: 'separator' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { label: '强制重新加载', role: 'forceReload' },
        { label: '切换开发者工具', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', role: 'toggleFullscreen' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { label: '最小化', role: 'minimize' },
        ...(isMac ? [{ label: '缩放', role: 'zoom' }, { label: '前置全部窗口', role: 'front' }] : []),
        { label: '关闭', role: 'close' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '关于 CIKE', click: showAbout },
        { label: '前往 GitHub 仓库', click: () => shell.openExternal('https://github.com/riboly/cike') },
      ],
    },
  );
  return Menu.buildFromTemplate(template);
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'CIKE',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  Menu.setApplicationMenu(buildApplicationMenu());

  mainWindow.webContents.on('will-navigate', (event, url) => { if (url !== uiURL) event.preventDefault(); });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  await mainWindow.loadFile(uiFile);
}

app.whenReady().then(async () => {
  applyChromiumEnv();
  try {
    const requireSafeStorage = () => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法安全读取或迁移代理凭据');
    };
    backend = await startBackend(undefined, {
      secretStorage: {
        encrypt: value => { requireSafeStorage(); return safeStorage.encryptString(value).toString('base64'); },
        decrypt: value => { requireSafeStorage(); return safeStorage.decryptString(Buffer.from(value, 'base64')); },
      },
      resolveSystemProxy: url => session.defaultSession.resolveProxy(url), downloadsDirectory: app.getPath('downloads'),
    });
  } catch (err) {
    console.error('[CIKE] backend failed to start:', err.message);
    dialog.showErrorBox('CIKE 无法启动', err.message);
    app.exit(1);
    return;
  }
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
let quitting = false;
app.on('before-quit', event => {
  if (quitting || !backend) return;
  event.preventDefault();
  quitting = true;
  backend.browsers.closeAll().finally(() => { backend.server.close(); app.quit(); });
});

// --- renderer IPC ---

function handle(channel, callback) {
  ipcMain.handle(channel, (event, ...args) => { trusted(event); return callback(event, ...args); });
}
handle('chromium-status', async () => {
  return chromiumStatus(DATA_DIR);
});

handle('chromium-download', async (event) => {
  if (backend.browsers.listOpen().length || backend.browsers.opening.size) throw new Error('请先关闭所有环境再更新内核');
  const send = (p) => event.sender.send('chromium-download-progress', p);
  try {
    const exe = await downloadChromium(DATA_DIR, send);
    process.env.LFB_CHROMIUM_EXECUTABLE = exe;
    return { ok: true, executable: exe };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

handle('open-data-dir', async () => {
  shell.openPath(backend.dataDir);
  return { ok: true };
});

handle('proxy-clipboard', async () => {
  try { return { ok: true, proxy: require('../src/proxyparse').parseProxyLine(await clipboard.readText()) }; }
  catch { return { ok: false }; }
});
