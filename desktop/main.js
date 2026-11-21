'use strict';
/* AutoCroper 데스크톱(Electron) 메인 프로세스.
 * 웹 앱 파일을 app://autocroper/ 로 내보내(보안 컨텍스트) Blob URL 워커 · OffscreenCanvas 가
 * 브라우저와 똑같이 동작하게 하고, 저장 폴더 · 파일 연결 같은 네이티브 기능은 preload.js 의
 * window.autocroperNative 로만 열어 준다. */

const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, protocol, session, shell } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { createUpdater } = require('./updater');
const { createScanner, sanitizeScanSettings, validateScanOptions, isDeviceId } = require('./scanner');
const { createFolderWatcher } = require('./watch-folder');

const SCHEME = 'app';
const HOST = 'autocroper';
const ORIGIN = SCHEME + '://' + HOST;
const START_URL = ORIGIN + '/index.html';
const APP_DIR = path.join(__dirname, '..');
const REPO_URL = 'https://github.com/yh-yeop/AutoCroper';

const IMAGE_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.gif': 'image/gif', '.avif': 'image/avif'
};
const MIME = Object.assign({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8'
}, IMAGE_TYPES);

// app.js 는 인라인 스크립트 · eval 없이 Blob URL 워커와 blob: 이미지를 쓴다.
const CSP = [
  "default-src 'self'",
  "script-src 'self' blob:",
  "worker-src 'self' blob:",
  "img-src 'self' blob: data:",
  "media-src 'self' blob: data:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "connect-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

const LIMITS = {
  openFileBytes: 512 * 1024 * 1024,   // 파일 연결로 여는 이미지 한 장
  openFileCount: 500,                 // 한 번에 여는 이미지 수
  saveFileBytes: 2 * 1024 * 1024 * 1024 - 1, // saveFile 로 쓰는 데이터 (ZIP 포함)
  pathLength: 4096,
  nameLength: 1024
};

// app:// 를 표준 · 보안 스킴으로: 보안 컨텍스트, 같은 출처 Blob URL 워커, fetch 지원
protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true }
}]);

/* ── 한 번만 실행 ───────────────────────────────────────── */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

function main() {
  let win = null;
  const pendingFiles = [];       // 렌더러가 onOpenFiles 를 부르기 전에 들어온 파일
  let rendererReady = false;     // 지금 로드된 페이지가 onOpenFiles 를 구독했는지
  const approvedFolders = new Set(); // saveFile 이 쓸 수 있는 폴더 (사용자가 고른 것만)
  let lastFolder = null;          // 마지막으로 확인한 저장 폴더 (will-download 용)
  // 자동 업데이트: 상태를 렌더러로 보낸다 (패키징된 앱에서만 실제로 확인)
  const updater = createUpdater({
    send: (status) => { if (win && !win.isDestroyed()) win.webContents.send('autocroper:update', status); }
  });
  // 스캐너 직접 연결 (Windows WIA, powershell.exe). 패키징 전에만 AUTOCROPER_PWSH 로 실행 파일을 바꿔 시험할 수 있다.
  const scanner = createScanner({
    powershell: () => {
      const override = process.env.AUTOCROPER_PWSH;
      if (!app.isPackaged && override) return override;
      if (process.platform !== 'win32') return null;
      return path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    },
    tempDir: () => { try { return app.getPath('temp'); } catch (_) { return os.tmpdir(); } }
  });
  const PREWARM_DELAY = 3000; // 창이 뜬 뒤 이만큼 있다가 스캐너 세션을 켜고 기억해 둔 장치에 미리 연결

  // 기억해 둔 장치 → 없으면 목록의 첫 장치(렌더러가 기본으로 고르는 것)에 미리 연결 (기다리지 않음)
  async function warmRemembered(devices) {
    const s = sanitizeScanSettings((await readSettings()).scan);
    let id = s && s.deviceId;
    if (Array.isArray(devices)) {
      if (!devices.some((d) => d.id === id)) id = devices.length ? devices[0].id : null;
    }
    if (id) scanner.warm(id).catch(() => {});
    else scanner.prewarm().catch(() => {});
  }
  // 감시 폴더: 새로 저장된 스캔 이미지를 파일 연결과 같은 통로(onOpenFiles)로 보낸다.
  const folderWatcher = createFolderWatcher({ onFiles: (paths) => { openPaths(paths); } });

  /* ── 설정 (userData/settings.json) ──────────────────────── */
  const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

  async function readSettings() {
    try {
      const data = JSON.parse(await fsp.readFile(settingsPath(), 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (_) {
      return {};
    }
  }

  async function writeSettings(patch) {
    const next = Object.assign(await readSettings(), patch);
    const file = settingsPath();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
    await fsp.rename(tmp, file);
  }

  async function isDirectory(p) {
    try { return (await fsp.stat(p)).isDirectory(); } catch (_) { return false; }
  }

  const folderKey = (p) => {
    const r = path.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };

  async function savedFolder() {
    const s = await readSettings();
    if (typeof s.saveFolder !== 'string' || !s.saveFolder || !path.isAbsolute(s.saveFolder)) return null;
    if (!(await isDirectory(s.saveFolder))) return null;
    approvedFolders.add(folderKey(s.saveFolder));
    lastFolder = s.saveFolder;
    return s.saveFolder;
  }

  async function startWatching(folder) {
    try { await folderWatcher.start(folder); return true; } catch (_) { return false; }
  }

  // 앱을 켤 때 저장해 둔 감시 폴더가 있으면 다시 감시한다.
  async function resumeWatch() {
    const s = await readSettings();
    if (typeof s.watchFolder !== 'string' || !s.watchFolder || !path.isAbsolute(s.watchFolder)) return;
    if (!(await isDirectory(s.watchFolder))) return;
    await startWatching(s.watchFolder);
  }

  /* ── 파일 연결 · 명령줄로 받은 이미지 ───────────────────── */
  function imagePathsFromArgv(argv, cwd) {
    const out = [];
    const seen = new Set();
    // 패키징 전(electron .)에는 argv[1] 이 앱 경로라 건너뛴다.
    const args = argv.slice(app.isPackaged ? 1 : 2);
    for (const a of args) {
      if (typeof a !== 'string' || !a || a.startsWith('-')) continue;
      const ext = path.extname(a).toLowerCase();
      if (!IMAGE_TYPES[ext]) continue;
      const abs = path.resolve(cwd || process.cwd(), a);
      const key = folderKey(abs);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(abs);
      if (out.length >= LIMITS.openFileCount) break;
    }
    return out;
  }

  async function readImageFiles(paths) {
    const files = [];
    for (const p of paths) {
      try {
        const st = await fsp.stat(p);
        if (!st.isFile() || st.size === 0 || st.size > LIMITS.openFileBytes) continue;
        const buf = await fsp.readFile(p);
        files.push({
          name: path.basename(p),
          type: IMAGE_TYPES[path.extname(p).toLowerCase()] || '',
          data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
        });
      } catch (_) { /* 읽을 수 없는 파일은 건너뛴다 */ }
    }
    return files;
  }

  async function openPaths(paths) {
    if (!paths.length) return;
    const files = await readImageFiles(paths);
    if (!files.length) return;
    if (rendererReady && win && !win.isDestroyed()) win.webContents.send('autocroper:open-files', files);
    else pendingFiles.push(...files);
  }

  function focusWindow() {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  app.on('second-instance', (_event, argv, cwd) => {
    focusWindow();
    openPaths(imagePathsFromArgv(argv, cwd));
  });

  // macOS: Finder 의 '열기' (Windows 대상이지만 해롭지 않다)
  app.on('open-file', (event, p) => {
    event.preventDefault();
    if (IMAGE_TYPES[path.extname(p).toLowerCase()]) openPaths([p]);
  });

  /* ── app:// 프로토콜 ─────────────────────────────────── */
  function notFound() {
    return new Response('찾을 수 없습니다.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }

  async function handleAppRequest(request) {
    let url;
    try { url = new URL(request.url); } catch (_) { return notFound(); }
    if (url.host !== HOST || (request.method !== 'GET' && request.method !== 'HEAD')) return notFound();
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch (_) { return notFound(); }
    if (rel === '/' || rel === '') rel = '/index.html';
    if (rel.includes('\0')) return notFound();
    const file = path.resolve(APP_DIR, '.' + rel);
    const relToApp = path.relative(APP_DIR, file);
    if (!relToApp || relToApp.startsWith('..') || path.isAbsolute(relToApp)) return notFound();
    // 숨김 파일 · 메인 프로세스 코드 · 의존성은 내보내지 않는다.
    const parts = relToApp.split(path.sep);
    if (parts.some((s) => s.startsWith('.')) || parts[0] === 'node_modules' ||
        (parts[0] === 'desktop' && parts[1] !== undefined) || parts[0] === 'package.json') return notFound();
    try {
      const st = await fsp.stat(file);
      if (!st.isFile()) return notFound();
      const body = request.method === 'HEAD' ? null : await fsp.readFile(file);
      const ext = path.extname(file).toLowerCase();
      const headers = {
        'content-type': MIME[ext] || 'application/octet-stream',
        'content-length': String(st.size),
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff'
      };
      if (ext === '.html') headers['content-security-policy'] = CSP;
      return new Response(body, { status: 200, headers });
    } catch (_) {
      return notFound();
    }
  }

  /* ── IPC (입력값은 전부 여기서 검사) ─────────────────── */
  const fromMainWindow = (event) =>
    win && !win.isDestroyed() && event.sender === win.webContents &&
    typeof event.senderFrame?.url === 'string' && event.senderFrame.url.startsWith(ORIGIN + '/');

  const isPathString = (v) => typeof v === 'string' && v.length > 0 && v.length <= LIMITS.pathLength &&
    !v.includes('\0') && path.isAbsolute(v);

  const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

  function sanitizeName(name) {
    let s = String(name).normalize('NFC');
    s = s.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_'); // 경로 구분자 · Windows 금지 문자
    s = s.replace(/^[\s.]+/, '').replace(/[\s.]+$/, '');    // 앞쪽 점(.., 숨김) · 끝 점/공백(Windows)
    if (!s) s = 'image';
    if (WIN_RESERVED.test(s)) s = '_' + s;
    if (s.length > 200) {
      const ext = path.extname(s).slice(0, 16);
      s = s.slice(0, 200 - ext.length) + ext;
    }
    return s;
  }

  function toBuffer(data) {
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return null;
  }

  function registerIpc() {
    ipcMain.on('autocroper:version', (event) => { event.returnValue = app.getVersion(); });

    ipcMain.handle('autocroper:choose-folder', async (event) => {
      if (!fromMainWindow(event)) return null;
      const current = await savedFolder();
      const res = await dialog.showOpenDialog(win, {
        title: '저장할 폴더 선택',
        buttonLabel: '이 폴더에 저장',
        defaultPath: current || app.getPath('pictures'),
        properties: ['openDirectory', 'createDirectory', 'promptToCreate', 'dontAddToRecent']
      });
      if (res.canceled || !res.filePaths || !res.filePaths[0]) return null;
      const folder = path.resolve(res.filePaths[0]);
      approvedFolders.add(folderKey(folder));
      lastFolder = folder;
      try { await writeSettings({ saveFolder: folder }); } catch (_) { /* 저장 실패해도 이번 실행에선 쓴다 */ }
      return folder;
    });

    ipcMain.handle('autocroper:get-save-folder', async (event) => {
      if (!fromMainWindow(event)) return null;
      return savedFolder();
    });

    ipcMain.handle('autocroper:save-file', async (event, folder, name, data) => {
      if (!fromMainWindow(event)) return { ok: false, error: '허용되지 않은 요청입니다.' };
      if (!isPathString(folder)) return { ok: false, error: '저장 폴더 경로가 올바르지 않습니다.' };
      if (typeof name !== 'string' || !name || name.length > LIMITS.nameLength) return { ok: false, error: '파일 이름이 올바르지 않습니다.' };
      const buf = toBuffer(data);
      if (!buf) return { ok: false, error: '저장할 데이터가 올바르지 않습니다.' };
      if (buf.byteLength > LIMITS.saveFileBytes) return { ok: false, error: '파일이 너무 큽니다.' };
      const dir = path.resolve(folder);
      if (!approvedFolders.has(folderKey(dir))) {
        // 앱을 다시 켠 뒤에도 저장해 둔 폴더면 허용
        const s = await readSettings();
        if (typeof s.saveFolder !== 'string' || folderKey(s.saveFolder) !== folderKey(dir)) {
          return { ok: false, error: '먼저 저장할 폴더를 선택해 주세요.' };
        }
        approvedFolders.add(folderKey(dir));
      }
      const target = path.join(dir, sanitizeName(name));
      if (path.dirname(target) !== dir) return { ok: false, error: '파일 이름이 올바르지 않습니다.' };
      try {
        await fsp.mkdir(dir, { recursive: true });
        try {
          if ((await fsp.stat(target)).isDirectory()) return { ok: false, error: '같은 이름의 폴더가 있어 저장할 수 없습니다.' };
        } catch (_) { /* 없으면 새로 만든다 */ }
        await fsp.writeFile(target, buf);
        return { ok: true, path: target };
      } catch (err) {
        const code = err && err.code;
        const msg = code === 'EACCES' || code === 'EPERM' ? '이 폴더에 쓸 권한이 없습니다.'
          : code === 'ENOSPC' ? '디스크 공간이 부족합니다.'
          : code === 'EBUSY' ? '다른 프로그램이 파일을 쓰고 있습니다.'
          : '저장하지 못했습니다.' + (code ? ' (' + code + ')' : '');
        return { ok: false, error: msg };
      }
    });

    ipcMain.handle('autocroper:open-folder', async (event, folder) => {
      if (!fromMainWindow(event) || !isPathString(folder)) return;
      // openPath 는 파일이면 실행까지 하므로 폴더만 연다.
      if (!(await isDirectory(folder))) return;
      await shell.openPath(path.resolve(folder));
    });

    ipcMain.handle('autocroper:open-files-ready', (event) => {
      if (!fromMainWindow(event)) return [];
      rendererReady = true;
      return pendingFiles.splice(0, pendingFiles.length);
    });

    /* 스캐너 */
    ipcMain.handle('autocroper:scan-devices', async (event) => {
      if (!fromMainWindow(event)) return { ok: false, error: '허용되지 않은 요청입니다.' };
      const r = await scanner.listDevices();
      // 렌더러는 시작할 때 목록을 받고 장치를 골라 둔다 → 그 장치에 미리 연결해 두면 첫 스캔이 빨라진다.
      if (r && r.ok && r.devices && r.devices.length) warmRemembered(r.devices).catch(() => {});
      return r;
    });

    // 사용자가 장치를 바꿨을 때 렌더러가 부른다. 연결이 끝나면(또는 실패하면) 끝난다. 결과는 알려 주지 않는다.
    ipcMain.handle('autocroper:scan-warm', async (event, deviceId) => {
      if (!fromMainWindow(event) || !isDeviceId(deviceId)) return;
      await scanner.warm(deviceId);
    });

    ipcMain.handle('autocroper:scan', async (event, opts) => {
      if (!fromMainWindow(event)) return { ok: false, error: '허용되지 않은 요청입니다.' };
      const sender = event.sender;
      const plain = opts && typeof opts === 'object' && !Array.isArray(opts)
        ? { deviceId: opts.deviceId, source: opts.source, dpi: opts.dpi, color: opts.color, area: opts.area } : null;
      // area 는 없으면 'full'. 그 밖의 값이 하나라도 틀리면 scanner.scan 이 같은 검사로 거절한다.
      const v = validateScanOptions(plain);
      if (v.ok && !scanner.busy()) {
        try { await writeSettings({ scan: v.value }); } catch (_) { /* 저장 못 해도 스캔은 한다 */ }
      }
      return scanner.scan(plain, (p) => {
        if (!sender.isDestroyed()) sender.send('autocroper:scan-progress', p);
      });
    });

    ipcMain.handle('autocroper:scan-settings', async (event) => {
      if (!fromMainWindow(event)) return null;
      return sanitizeScanSettings((await readSettings()).scan);
    });

    ipcMain.handle('autocroper:scan-cancel', (event) => {
      if (!fromMainWindow(event)) return;
      scanner.cancel();
    });

    /* 감시 폴더 */
    ipcMain.handle('autocroper:choose-watch-folder', async (event) => {
      if (!fromMainWindow(event)) return null;
      const res = await dialog.showOpenDialog(win, {
        title: '스캔 파일이 저장되는 폴더 선택',
        buttonLabel: '이 폴더 감시',
        defaultPath: folderWatcher.folder() || app.getPath('documents'),
        properties: ['openDirectory', 'dontAddToRecent']
      });
      if (res.canceled || !res.filePaths || !res.filePaths[0]) return null;
      const folder = path.resolve(res.filePaths[0]);
      if (!(await startWatching(folder))) return null;
      try { await writeSettings({ watchFolder: folder }); } catch (_) { /* 이번 실행에서만 감시 */ }
      return folder;
    });

    ipcMain.handle('autocroper:get-watch-folder', (event) => (fromMainWindow(event) ? folderWatcher.folder() : null));

    ipcMain.handle('autocroper:stop-watch', async (event) => {
      if (!fromMainWindow(event)) return;
      folderWatcher.stop();
      try { await writeSettings({ watchFolder: undefined }); } catch (_) { /* 무시 */ }
    });

    ipcMain.handle('autocroper:update-status', (event) => (fromMainWindow(event) ? updater.status() : null));

    ipcMain.handle('autocroper:update-check', async (event) => {
      if (!fromMainWindow(event)) return;
      await updater.check();
    });

    ipcMain.handle('autocroper:update-install', (event) => {
      if (!fromMainWindow(event)) return;
      updater.install();
    });
  }

  // 도움말 → 업데이트 확인: 사용자가 직접 누른 것이므로 결과를 대화 상자로 알린다.
  async function checkUpdatesFromMenu() {
    const st = await updater.checkAndWait();
    if (!win || win.isDestroyed()) return;
    const box = (type, message, detail) => dialog.showMessageBox(win, { type, title: '업데이트 확인', buttons: ['확인'], message, detail });
    if (st.state === 'downloaded') {
      const r = await dialog.showMessageBox(win, {
        type: 'info', title: '업데이트 확인', buttons: ['지금 다시 시작', '나중에'], defaultId: 0, cancelId: 1,
        message: '새 버전 ' + (st.version || '') + '을(를) 받아 두었습니다.',
        detail: '다시 시작하면 설치됩니다. 나중에를 고르면 앱을 끌 때 설치됩니다.'
      });
      if (r.response === 0) updater.install();
    } else if (st.state === 'available' || st.state === 'downloading') {
      box('info', '새 버전 ' + (st.version || '') + '을(를) 내려받고 있습니다.', '다 받으면 앱을 끌 때 자동으로 설치됩니다.');
    } else if (st.state === 'error') {
      box('warning', '업데이트를 확인하지 못했습니다.', st.message || '');
    } else {
      box('info', '최신 버전입니다.', 'AutoCroper ' + app.getVersion() + (st.message ? '\n' + st.message : ''));
    }
  }

  /* ── 메뉴 (Alt 키로 표시) ─────────────────────────────── */
  function buildMenu() {
    const template = [
      { label: '파일(&F)', submenu: [{ role: 'quit', label: '끝내기' }] },
      {
        label: '편집(&E)',
        submenu: [
          { role: 'undo', label: '실행 취소' }, { role: 'redo', label: '다시 실행' }, { type: 'separator' },
          { role: 'cut', label: '잘라내기' }, { role: 'copy', label: '복사' }, { role: 'paste', label: '붙여넣기' },
          { role: 'selectAll', label: '모두 선택' }
        ]
      },
      {
        label: '보기(&V)',
        submenu: [
          { role: 'zoomIn', label: '확대' }, { role: 'zoomOut', label: '축소' }, { role: 'resetZoom', label: '실제 크기' },
          { type: 'separator' }, { role: 'togglefullscreen', label: '전체 화면' }
        ].concat(app.isPackaged ? [] : [
          { type: 'separator' }, { role: 'reload', label: '새로 고침' }, { role: 'toggleDevTools', label: '개발자 도구' }
        ])
      },
      {
        label: '도움말(&H)',
        submenu: [
          { label: '업데이트 확인', click: () => { checkUpdatesFromMenu().catch(() => {}); } },
          { type: 'separator' },
          { label: '소스 코드 (GitHub)', click: () => shell.openExternal(REPO_URL) },
          {
            label: 'AutoCroper 정보',
            click: () => dialog.showMessageBox(win, {
              type: 'info', title: 'AutoCroper 정보', buttons: ['확인'],
              message: 'AutoCroper ' + app.getVersion(),
              detail: '흰 배경 사진 · 스캔본의 흰 여백을 자동으로 잘라 냅니다.\n이미지는 이 컴퓨터 밖으로 전송되지 않습니다.\n\nMIT 라이선스 · ' + REPO_URL
            })
          }
        ]
      }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  /* ── 창 ─────────────────────────────────────────────── */
  function isExternalHttp(u) {
    try { const p = new URL(u); return p.protocol === 'https:' || p.protocol === 'http:'; } catch (_) { return false; }
  }

  function isAllowedInternal(u) {
    try {
      const p = new URL(u);
      return p.origin === ORIGIN && (p.pathname === '/' || p.pathname === '/index.html');
    } catch (_) { return false; }
  }

  function createWindow() {
    win = new BrowserWindow({
      width: 1280,
      height: 900,
      minWidth: 400,
      minHeight: 600,
      title: 'AutoCroper',
      icon: path.join(APP_DIR, 'icons', 'icon-512.png'),
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#161615' : '#f6f6f4',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false,
        additionalArguments: ['--autocroper-version=' + app.getVersion()]
      }
    });

    win.once('ready-to-show', () => {
      win.show();
      updater.start();
      // 스캐너 세션을 미리 켜 둔다 (렌더러가 그 전에 목록을 부르면 그때 이미 켜진다)
      setTimeout(() => { warmRemembered(null).catch(() => {}); }, PREWARM_DELAY);
    });
    win.on('page-title-updated', (e) => e.preventDefault()); // 창 제목은 항상 AutoCroper
    win.on('closed', () => { win = null; rendererReady = false; });

    const wc = win.webContents;
    // 다른 페이지 · 다른 출처로 나가지 않는다. 외부 http(s) 링크는 기본 브라우저로.
    wc.on('will-navigate', (event, url) => {
      if (isAllowedInternal(url)) return;
      event.preventDefault();
      if (isExternalHttp(url)) shell.openExternal(url);
    });
    wc.on('will-redirect', (event, url) => {
      if (!isAllowedInternal(url)) event.preventDefault();
    });
    wc.setWindowOpenHandler(({ url }) => {
      if (isExternalHttp(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('will-attach-webview', (event) => event.preventDefault());
    // 새로 고침 · 이동하면 새 페이지가 다시 구독할 때까지 파일을 모아 둔다.
    wc.on('did-start-navigation', (details) => {
      if (details && details.isMainFrame && !details.isSameDocument) rendererReady = false;
    });

    win.loadURL(START_URL);
  }

  app.whenReady().then(async () => {
    protocol.handle(SCHEME, handleAppRequest);

    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    // <a download> 로 저장할 때 저장 대화 상자를 저장 폴더에서 연다.
    ses.on('will-download', (_event, item) => {
      const folder = lastFolder && fs.existsSync(lastFolder) ? lastFolder : null;
      if (folder) item.setSaveDialogOptions({ title: '다른 이름으로 저장', defaultPath: path.join(folder, sanitizeName(item.getFilename())) });
    });
    savedFolder().catch(() => null);

    registerIpc();
    buildMenu();
    createWindow();
    openPaths(imagePathsFromArgv(process.argv, process.cwd()));
    resumeWatch().catch(() => {});
  });

  app.on('will-quit', () => {
    // 진행 중인 스캔을 멈추고 세션 PowerShell 에 quit (2초 안에 안 끝나면 강제 종료; 앱이 먼저 끝나도 stdin 이 닫혀 스스로 끝난다)
    scanner.shutdown().catch(() => {});
    folderWatcher.stop();
  });

  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  app.on('window-all-closed', () => app.quit());

  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
}
