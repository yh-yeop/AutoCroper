'use strict';
/* AutoCroper 데스크톱 preload (sandbox). 웹 페이지에는 window.autocroperNative 만 열어 준다. */

const { contextBridge, ipcRenderer } = require('electron');

function readVersion() {
  const prefix = '--autocroper-version=';
  const arg = (process.argv || []).find((a) => typeof a === 'string' && a.startsWith(prefix));
  if (arg) return arg.slice(prefix.length);
  try { return String(ipcRenderer.sendSync('autocroper:version') || ''); } catch (_) { return ''; }
}

// IPC 로 받은 Uint8Array → 딱 맞는 크기의 ArrayBuffer
function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
      ? data.buffer
      : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  return new ArrayBuffer(0);
}

function normalizeFiles(list) {
  if (!Array.isArray(list)) return [];
  return list.map((f) => ({
    name: String((f && f.name) || 'image'),
    type: String((f && f.type) || ''),
    data: toArrayBuffer(f && f.data)
  }));
}

const subscribers = [];
let listening = false;
const queued = [];

function deliver(files) {
  if (!files.length) return;
  if (!subscribers.length) { queued.push(files); return; }
  subscribers.forEach((cb) => {
    try { cb(files); } catch (err) { console.error(err); }
  });
}

// 자동 업데이트 상태: { state, version?, percent?, message? }
const UPDATE_STATES = ['checking', 'available', 'none', 'downloading', 'downloaded', 'error'];
const updateSubscribers = [];
let updateListening = false;
let lastUpdate = null;

function normalizeUpdate(s) {
  if (!s || typeof s !== 'object' || UPDATE_STATES.indexOf(s.state) < 0) return null;
  const out = { state: s.state };
  if (typeof s.version === 'string' && s.version) out.version = s.version;
  if (typeof s.percent === 'number' && isFinite(s.percent)) out.percent = s.percent;
  if (typeof s.message === 'string' && s.message) out.message = s.message;
  return out;
}

function deliverUpdate(status, only) {
  (only ? [only] : updateSubscribers).forEach((cb) => {
    try { cb(Object.assign({}, status)); } catch (err) { console.error(err); }
  });
}

// 스캔 진행: { state: 'scanning' | 'ready' | 'page', page? }
// 스캔 결과: { ok, files?, error?, cancelled?, timing?: { setupMs, scanMs, totalMs, waitMs, warm, session } }
const scanSubscribers = [];
let scanListening = false;

function normalizeScanProgress(p) {
  if (!p || typeof p !== 'object' || (p.state !== 'scanning' && p.state !== 'ready' && p.state !== 'page')) return null;
  const out = { state: p.state };
  if (Number.isInteger(p.page) && p.page > 0) out.page = p.page;
  return out;
}

function normalizeScanResult(r) {
  if (!r || typeof r !== 'object') return { ok: false, error: '스캔하지 못했습니다.' };
  const out = { ok: r.ok === true };
  if (Array.isArray(r.files)) out.files = normalizeFiles(r.files);
  if (typeof r.error === 'string' && r.error) out.error = r.error;
  if (r.cancelled === true) out.cancelled = true;
  const t = r.timing;
  if (t && typeof t === 'object') {
    const ms = (v) => (typeof v === 'number' && isFinite(v) && v >= 0 ? Math.round(v) : null);
    out.timing = {
      setupMs: ms(t.setupMs), scanMs: ms(t.scanMs), totalMs: ms(t.totalMs), waitMs: ms(t.waitMs),
      warm: t.warm === true, session: t.session === true
    };
  }
  return out;
}

const SCAN_AREAS = ['full', 'top2_3', 'top1_2'];

function normalizeScanSettings(s) {
  if (!s || typeof s !== 'object') return null;
  const out = {};
  if (typeof s.deviceId === 'string' && s.deviceId) out.deviceId = s.deviceId;
  if (s.source === 'flatbed' || s.source === 'feeder') out.source = s.source;
  if (typeof s.dpi === 'number' && isFinite(s.dpi)) out.dpi = s.dpi;
  if (s.color === 'color' || s.color === 'gray') out.color = s.color;
  if (SCAN_AREAS.indexOf(s.area) >= 0) out.area = s.area;
  return Object.keys(out).length ? out : null;
}

const isDeviceId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 500 && !/[\u0000-\u001f\u007f]/.test(v);

function normalizeDevices(r) {
  if (!r || typeof r !== 'object') return { ok: false, error: '스캐너 목록을 가져오지 못했습니다.' };
  const out = { ok: r.ok === true };
  if (Array.isArray(r.devices)) {
    out.devices = r.devices.map((d) => ({
      id: String(d.id), name: String(d.name), feeder: d.feeder === true, flatbed: d.flatbed === true
    }));
  }
  if (typeof r.error === 'string' && r.error) out.error = r.error;
  return out;
}

const errorText = (prefix, err) => prefix + ' ' + String((err && err.message) || err);

contextBridge.exposeInMainWorld('autocroperNative', {
  isDesktop: true,
  version: readVersion(),

  chooseFolder: () => ipcRenderer.invoke('autocroper:choose-folder'),

  getSaveFolder: () => ipcRenderer.invoke('autocroper:get-save-folder'),

  saveFile: (folder, name, data) => {
    if (typeof folder !== 'string' || typeof name !== 'string') {
      return Promise.resolve({ ok: false, error: '폴더와 파일 이름은 문자열이어야 합니다.' });
    }
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
      return Promise.resolve({ ok: false, error: '저장할 데이터는 ArrayBuffer 여야 합니다.' });
    }
    return ipcRenderer.invoke('autocroper:save-file', folder, name, data)
      .catch((err) => ({ ok: false, error: '저장하지 못했습니다. ' + String((err && err.message) || err) }));
  },

  openFolder: (folder) => {
    if (typeof folder !== 'string') return Promise.resolve();
    return ipcRenderer.invoke('autocroper:open-folder', folder).then(() => undefined, () => undefined);
  },

  onOpenFiles: (cb) => {
    if (typeof cb !== 'function') return;
    subscribers.push(cb);
    while (queued.length) deliver(queued.shift());
    if (listening) return;
    listening = true;
    ipcRenderer.on('autocroper:open-files', (_event, files) => deliver(normalizeFiles(files)));
    // 앱 시작 전(명령줄 · 파일 연결)에 들어와 메인 프로세스가 모아 둔 파일
    ipcRenderer.invoke('autocroper:open-files-ready')
      .then((files) => deliver(normalizeFiles(files)), () => {});
  },

  onUpdate: (cb) => {
    if (typeof cb !== 'function') return;
    updateSubscribers.push(cb);
    if (lastUpdate) deliverUpdate(lastUpdate, cb);
    if (updateListening) return;
    updateListening = true;
    ipcRenderer.on('autocroper:update', (_event, s) => {
      const st = normalizeUpdate(s);
      if (!st) return;
      lastUpdate = st;
      deliverUpdate(st);
    });
    // 구독 전에 이미 나온 상태 (새로 고침 · 늦은 구독)
    ipcRenderer.invoke('autocroper:update-status').then((s) => {
      const st = normalizeUpdate(s);
      if (st && !lastUpdate) { lastUpdate = st; deliverUpdate(st); }
    }, () => {});
  },

  checkForUpdates: () => ipcRenderer.invoke('autocroper:update-check').then(() => undefined, () => undefined),

  installUpdate: () => ipcRenderer.invoke('autocroper:update-install').then(() => undefined, () => undefined),

  /* ── 스캐너 (Windows WIA) ── */
  scanDevices: () => ipcRenderer.invoke('autocroper:scan-devices')
    .then(normalizeDevices, (err) => ({ ok: false, error: errorText('스캐너 목록을 가져오지 못했습니다.', err) })),

  scan: (opts) => {
    if (!opts || typeof opts !== 'object') return Promise.resolve({ ok: false, error: '스캔 설정이 올바르지 않습니다.' });
    const plain = { deviceId: opts.deviceId, source: opts.source, dpi: opts.dpi, color: opts.color };
    if (opts.area !== undefined) plain.area = opts.area; // 'full' | 'top2_3' | 'top1_2' (main 이 검사; 없으면 'full')
    return ipcRenderer.invoke('autocroper:scan', plain)
      .then(normalizeScanResult, (err) => ({ ok: false, error: errorText('스캔하지 못했습니다.', err) }));
  },

  getScanSettings: () => ipcRenderer.invoke('autocroper:scan-settings').then(normalizeScanSettings, () => null),

  // 장치를 바꿨을 때 미리 연결해 둔다 (다음 스캔이 연결을 건너뛴다). 끝나면 resolve, 실패해도 reject 하지 않는다.
  warmScanner: (deviceId) => {
    if (!isDeviceId(deviceId)) return Promise.resolve();
    return ipcRenderer.invoke('autocroper:scan-warm', deviceId).then(() => undefined, () => undefined);
  },

  onScanProgress: (cb) => {
    if (typeof cb !== 'function') return;
    scanSubscribers.push(cb);
    if (scanListening) return;
    scanListening = true;
    ipcRenderer.on('autocroper:scan-progress', (_event, p) => {
      const st = normalizeScanProgress(p);
      if (!st) return;
      scanSubscribers.forEach((fn) => {
        try { fn(Object.assign({}, st)); } catch (err) { console.error(err); }
      });
    });
  },

  cancelScan: () => ipcRenderer.invoke('autocroper:scan-cancel').then(() => undefined, () => undefined),

  /* ── 감시 폴더 (새 스캔 파일은 onOpenFiles 로 들어온다) ── */
  chooseWatchFolder: () => ipcRenderer.invoke('autocroper:choose-watch-folder').then((f) => f || null, () => null),

  getWatchFolder: () => ipcRenderer.invoke('autocroper:get-watch-folder').then((f) => f || null, () => null),

  stopWatch: () => ipcRenderer.invoke('autocroper:stop-watch').then(() => undefined, () => undefined)
});
