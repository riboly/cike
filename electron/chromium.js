'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { pipeline } = require('stream/promises');
const exec = promisify(execFile);
const { privateDirectory, writePrivate } = require('../src/privatefiles');
const inProgress = new Map();
function chromiumEntry() {
  const file = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'browsers.json');
  return JSON.parse(fs.readFileSync(file)).browsers.find(b => b.name === 'chromium');
}
function cftPlatform() {
  const platform = { 'darwin-arm64': 'mac-arm64', 'darwin-x64': 'mac-x64', 'linux-x64': 'linux64', 'win32-x64': 'win64' }[`${process.platform}-${process.arch}`];
  if (!platform) throw new Error('不支持此平台的 Chromium 下载');
  return platform;
}
// The Playwright-locked version comes from cdn.playwright.dev (the same
// host Playwright itself uses). Any other version comes from the public
// Chrome for Testing storage, which hosts every known-good CfT build.
function downloadUrlFor(version) {
  const platform = cftPlatform();
  if (version === chromiumEntry().browserVersion) {
    const host = process.env.PLAYWRIGHT_DOWNLOAD_HOST || 'https://cdn.playwright.dev';
    return `${host}/builds/cft/${version}/${platform}/chrome-${platform}.zip`;
  }
  return `https://storage.googleapis.com/chrome-for-testing-public/${version}/${platform}/chrome-${platform}.zip`;
}
function downloadUrl() { return downloadUrlFor(chromiumEntry().browserVersion); }
function browserRoot(dir) { return path.join(dir, 'browsers'); }
function executableMarker(dir) { return path.join(browserRoot(dir), 'chromium-executable.txt'); }

function fetchJson(url, maxBytes = 20 * 1024 * 1024, redirects = 0) {
  if (redirects > 5 || new URL(url).protocol !== 'https:') throw new Error('版本列表必须使用 HTTPS');
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'CIKE' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return fetchJson(new URL(res.headers.location, url).href, maxBytes, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`版本列表请求失败：HTTP ${res.statusCode}`)); }
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { res.destroy(new Error('版本列表过大')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('版本列表请求超时')));
  });
}

// Version list for the settings dropdown. Cached for an hour in the main
// process so opening settings does not refetch a multi-MB list every time.
// Failure of either source only shrinks the list: the locked version and
// the custom-version input always remain available.
let versionsCache = null;
async function listChromiumVersions() {
  const locked = chromiumEntry().browserVersion;
  if (versionsCache && Date.now() - versionsCache.at < 3600000) return versionsCache.list;
  const versions = [{ version: locked, label: '推荐（Playwright 锁定）' }];
  const seen = new Set([locked]);
  const add = (version, label) => {
    if (typeof version === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(version) && !seen.has(version)) {
      seen.add(version);
      versions.push({ version, label });
    }
  };
  try {
    const data = await fetchJson('https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json', 1024 * 1024);
    for (const channel of ['Stable', 'Beta', 'Dev', 'Canary']) {
      add(data?.channels?.[channel]?.version, `${channel} 最新`);
    }
  } catch { /* keep the locked version; the user can still type a version */ }
  try {
    const platform = cftPlatform();
    const data = await fetchJson('https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json');
    const list = Array.isArray(data?.versions) ? data.versions : [];
    const recent = list.filter(v => (v.downloads?.chrome || []).some(d => d.platform === platform)).slice(-30).reverse();
    for (const entry of recent) add(entry.version, '近期版本');
  } catch { /* same fallback */ }
  const result = { lockedVersion: locked, versions };
  versionsCache = { at: Date.now(), list: result };
  return result;
}

const VERSION_RE = /\d+\.\d+\.\d+\.\d+/;
const psLit = s => `'${String(s).replace(/'/g, "''")}'`;
// Windows: read the file version without executing the binary. Running
// chrome.exe --version used to be the only check, and on the user's machine
// it deterministically failed (Command failed, no stderr) even though the
// bundle was extracted correctly — most likely a missing VC++ runtime or
// an antivirus/sandbox block on executing a fresh binary. A file version
// proves the bundle is the right one; a failed exec must not delete it.
async function fileVersionOnWindows(executable) {
  try {
    const { stdout } = await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Item -LiteralPath ${psLit(executable)}).VersionInfo.FileVersion`], { timeout: 10000, maxBuffer: 65536 });
    return stdout.match(VERSION_RE)?.[0] || null;
  } catch { return null; }
}
async function execVersion(executable) {
  try {
    const { stdout } = await exec(executable, ['--version'], { timeout: 10000, maxBuffer: 65536 });
    return stdout.match(VERSION_RE)?.[0] || null;
  } catch { return null; }
}
async function resolveExecutableVersion(executable) {
  if (process.platform === 'win32') {
    const fileVersion = await fileVersionOnWindows(executable);
    if (fileVersion) {
      const runVersion = await execVersion(executable);
      return { version: fileVersion, source: 'file', runCheckFailed: runVersion === null };
    }
  }
  const runVersion = await execVersion(executable);
  if (runVersion) return { version: runVersion, source: 'exec', runCheckFailed: false };
  return { version: null, source: null, runCheckFailed: true };
}

async function chromiumStatus(dir) {
  const targetVersion = chromiumEntry().browserVersion;
  try {
    const executable = fs.readFileSync(executableMarker(dir), 'utf8').trim();
    if (!executable || !fs.existsSync(executable)) throw new Error('no executable');
    const resolved = await resolveExecutableVersion(executable);
    if (!resolved.version) throw new Error('no version');
    return { installed: true, executable, version: resolved.version, targetVersion, updateAvailable: resolved.version !== targetVersion, runCheckFailed: resolved.runCheckFailed, versionSource: resolved.source };
  } catch { /* not installed or unusable */ }
  return { installed: false, executable: null, version: null, targetVersion, updateAvailable: true, runCheckFailed: false, versionSource: null };
}
async function downloadFile(url, dest, onProgress, redirects = 0) {
  if (redirects > 5 || new URL(url).protocol !== 'https:') throw new Error('内核下载必须使用 HTTPS，且不能无限重定向');
  const response = await new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'CIKE' } }, resolve);
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('内核下载超时')));
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
    response.resume();
    return downloadFile(new URL(response.headers.location, url).href, dest, onProgress, redirects + 1);
  }
  if (response.statusCode !== 200) { response.resume(); throw new Error(`内核下载失败：HTTP ${response.statusCode}`); }
  const total = Number(response.headers['content-length']) || 0;
  let done = 0;
  response.on('data', chunk => {
    done += chunk.length;
    if (done > 1024 * 1024 * 1024) response.destroy(new Error('内核安装包异常过大'));
    onProgress?.({ done, total, pct: total ? Math.round(done / total * 100) : 0 });
  });
  await pipeline(response, fs.createWriteStream(dest, { flags: 'wx', mode: 0o600 }));
}
function findExecutable(root) {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (e.name.endsWith('.app')) {
        const macos = path.join(full, 'Contents', 'MacOS');
        return path.join(macos, fs.readdirSync(macos).find(n => !n.startsWith('.')));
      }
      const found = findExecutable(full); if (found) return found;
    } else if (e.isFile() && ((process.platform === 'linux' && e.name === 'chrome') || (process.platform === 'win32' && e.name === 'chrome.exe'))) return full;
  }
  return null;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Windows file locks (antivirus / indexer scanning freshly extracted files)
// make directory removal flaky right after extraction: retry it instead of
// letting one locked file fail the whole install, and never let a cleanup
// error replace the real install error.
async function removeWithRetry(target, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    try { fs.rmSync(target, { recursive: true, force: true }); return true; }
    catch { if (i === attempts - 1) return false; await sleep(250); }
  }
  return false;
}

// Windows has no /usr/bin/unzip: use the built-in PowerShell Expand-Archive
// (Windows 10+). dest must not be pre-created on Windows: Expand-Archive
// creates it, and creating it first is what used to make the later
// rename/cleanup hit EPERM on locked files.
async function extractZip(zip, dest) {
  if (process.platform === 'win32') {
    await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath ${psLit(zip)} -DestinationPath ${psLit(dest)} -Force`],
      { timeout: 600000 });
    return;
  }
  await exec('/usr/bin/unzip', ['-q', zip, '-d', dest], { timeout: 600000 });
}

// If a previous download already extracted the requested version (for
// example the last attempt failed only at the version check, after
// extraction), adopt that folder instead of downloading ~170 MB again.
async function adoptExisting(dir, version) {
  try {
    const root = browserRoot(dir);
    for (const entry of fs.readdirSync(root)) {
      if (entry === 'apps' || entry.startsWith('.install-')) continue;
      const folder = path.join(root, entry);
      try {
        if (!fs.statSync(folder).isDirectory()) continue;
        const executable = findExecutable(folder);
        if (!executable) continue;
        const resolved = await resolveExecutableVersion(executable);
        if (resolved.version === version) return { executable, runCheckFailed: resolved.runCheckFailed };
      } catch { /* try the next folder */ }
    }
  } catch { /* no browsers dir yet */ }
  return null;
}

async function install(dir, version, onProgress) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) throw new Error('内核版本号格式不正确，例如 156.0.8078.4');
  const status = await chromiumStatus(dir);
  if (status.installed && status.version === version) return { executable: status.executable, runCheckFailed: status.runCheckFailed };
  privateDirectory(browserRoot(dir));
  // Best-effort cleanup of leftovers from earlier failed installs (the old
  // .install-* staging dirs). A locked leftover must not block a new install.
  try {
    for (const entry of fs.readdirSync(browserRoot(dir))) {
      if (entry.startsWith('.install-')) await removeWithRetry(path.join(browserRoot(dir), entry));
    }
  } catch { /* ignore: a fresh install does not depend on this */ }
  const adopted = await adoptExisting(dir, version);
  if (adopted) {
    writePrivate(executableMarker(dir), adopted.executable + '\n');
    onProgress?.({ done: 1, total: 1, pct: 100 });
    return adopted;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-chromium-'));
  let destination = null;
  try {
    const zip = path.join(tmp, 'chromium.zip');
    await downloadFile(downloadUrlFor(version), zip, onProgress);
    // Extract straight into the final directory instead of staging + rename:
    // renaming a just-extracted tree on Windows failed with EPERM when
    // antivirus/indexer still held a file. Old kernels stay usable because
    // the marker is only rewritten on success.
    do { destination = path.join(browserRoot(dir), `${version}-${crypto.randomBytes(3).toString('hex')}`); }
    while (fs.existsSync(destination));
    await extractZip(zip, destination);
    const executable = findExecutable(destination);
    if (!executable) throw new Error('安装包中没有 Chromium');
    const resolved = await resolveExecutableVersion(executable);
    if (!resolved.version) throw new Error('无法确认下载的 Chromium 版本：文件版本与运行版本均读取失败，请检查杀毒拦截或重新下载');
    if (resolved.version !== version) throw new Error(`下载的内核版本不匹配：期望 ${version}，实际 ${resolved.version}`);
    // Keep the downloaded bundle unchanged, including its icon.
    const final = path.join(destination, path.relative(destination, executable));
    writePrivate(executableMarker(dir), final + '\n');
    onProgress?.({ done: 1, total: 1, pct: 100 });
    return { executable: final, runCheckFailed: resolved.runCheckFailed };
  } catch (error) {
    if (destination) await removeWithRetry(destination);
    throw error;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* tmp cleanup must not mask the install error */ }
  }
}
async function downloadChromium(dir, versionOrProgress, maybeProgress) {
  let version = chromiumEntry().browserVersion;
  let onProgress = maybeProgress;
  if (typeof versionOrProgress === 'function') onProgress = versionOrProgress;
  else if (typeof versionOrProgress === 'string') version = versionOrProgress;
  const key = `${dir}::${version}`;
  if (inProgress.has(key)) return inProgress.get(key);
  const promise = install(dir, version, onProgress);
  inProgress.set(key, promise);
  try { return await promise; } finally { inProgress.delete(key); }
}
module.exports = { chromiumStatus, downloadChromium, downloadUrl, downloadUrlFor, listChromiumVersions, executableMarker, browserRoot };
