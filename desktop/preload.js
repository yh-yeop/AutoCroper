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

  installUpdate: () => ipcRenderer.invoke('autocroper:update-install').then(() => undefined, () => undefined)
});
