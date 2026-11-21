'use strict';
/* 스캐너 직접 연결 (Windows WIA). 네이티브 모듈 없이 powershell.exe 로 wia-scripts.js 의 스크립트를 돌린다.
 * Electron 에 기대지 않아 Node 만으로 시험할 수 있다. 실행 파일 경로 · 임시 폴더 · 시간 제한은 밖에서 넣는다. */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { LIST_DEVICES_PS1, SCAN_PS1, scriptBytes } = require('./wia-scripts');

const SOURCES = ['flatbed', 'feeder'];
const DPIS = [150, 200, 300, 600];
const COLORS = ['color', 'gray'];
const DEVICE_ID_MAX = 500;
const MAX_PAGES = 100;

const DEFAULTS = {
  listTimeout: 90 * 1000,             // 장치 목록 (장치마다 Connect 해서 기능을 읽는다)
  flatbedTimeout: 5 * 60 * 1000,      // 평판 한 장
  feederTimeout: 10 * 60 * 1000,      // 급지대: 처음 10분
  feederPerPage: 3 * 60 * 1000,       //   한 장 받을 때마다 '지금부터 3분' 으로 늘린다
  feederHardCap: 60 * 60 * 1000,      //   그래도 최대 60분
  fileBytes: 512 * 1024 * 1024,       // 한 장
  totalBytes: 1024 * 1024 * 1024      // 한 번 스캔에서 렌더러로 보내는 합계
};

const CANCELLED_MESSAGE = '스캔을 취소했습니다.';

/* ── 입력 검사 ─────────────────────────────────────────── */
function validateScanOptions(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, error: '스캔 설정이 올바르지 않습니다.' };
  const { deviceId, source, dpi, color } = o;
  if (typeof deviceId !== 'string' || !deviceId || deviceId.length > DEVICE_ID_MAX || /[\u0000-\u001f\u007f]/.test(deviceId)) {
    return { ok: false, error: '스캐너를 먼저 선택해 주세요.' };
  }
  if (typeof source !== 'string' || SOURCES.indexOf(source) < 0) return { ok: false, error: '원고 위치(평판 · 급지대)가 올바르지 않습니다.' };
  if (typeof dpi !== 'number' || DPIS.indexOf(dpi) < 0) return { ok: false, error: '해상도는 150 · 200 · 300 · 600 dpi 중에서 골라 주세요.' };
  if (typeof color !== 'string' || COLORS.indexOf(color) < 0) return { ok: false, error: '색상(컬러 · 흑백)이 올바르지 않습니다.' };
  return { ok: true, value: { deviceId, source, dpi, color } };
}

// settings.json 의 scan 값 → 올바른 항목만 남긴다 (없으면 null)
function sanitizeScanSettings(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  const out = {};
  if (typeof s.deviceId === 'string' && s.deviceId && s.deviceId.length <= DEVICE_ID_MAX &&
      !/[\u0000-\u001f\u007f]/.test(s.deviceId)) out.deviceId = s.deviceId;
  if (SOURCES.indexOf(s.source) >= 0) out.source = s.source;
  if (DPIS.indexOf(s.dpi) >= 0) out.dpi = s.dpi;
  if (COLORS.indexOf(s.color) >= 0) out.color = s.color;
  return Object.keys(out).length ? out : null;
}

/* ── HRESULT → 한국어 ─────────────────────────────────── */
// 값은 Microsoft 문서 'Error Codes (WIA)' 기준
const WIA_MESSAGES = {
  0x80210001: '스캐너에서 알 수 없는 오류가 났습니다. 스캐너를 껐다 켠 뒤 다시 시도해 주세요.',          // GENERAL_ERROR
  0x80210002: '급지대(ADF)에 종이가 걸렸습니다. 걸린 종이를 빼고 다시 시도해 주세요.',                  // PAPER_JAM
  0x80210003: '급지대(ADF)에 원고가 없습니다. 원고를 넣고 다시 시도해 주세요.',                         // PAPER_EMPTY
  0x80210004: '급지대(ADF)에 문제가 생겼습니다. 원고가 바르게 놓였는지 확인해 주세요.',                  // PAPER_PROBLEM
  0x80210005: '스캐너가 꺼져 있거나 연결되어 있지 않습니다. 전원과 USB · 네트워크 연결을 확인해 주세요.', // OFFLINE
  0x80210006: '스캐너가 사용 중입니다. 다른 프로그램의 스캔이나 복사 · 인쇄가 끝난 뒤 다시 시도해 주세요.', // BUSY
  0x80210007: '스캐너가 예열 중입니다. 잠시 뒤에 다시 시도해 주세요.',                                  // WARMING_UP
  0x80210008: '스캐너를 확인해 주세요. 전원 · 연결 상태와 복합기 화면의 안내를 확인한 뒤 다시 시도해 주세요.', // USER_INTERVENTION
  0x80210009: '스캐너 연결이 끊겼습니다. 다시 연결한 뒤 스캐너 목록을 새로 고쳐 주세요.',                // ITEM_DELETED
  0x8021000A: '스캐너와 통신하지 못했습니다. 전원과 USB · 네트워크 연결을 확인해 주세요.',               // DEVICE_COMMUNICATION
  0x8021000B: '이 스캐너가 지원하지 않는 기능입니다.',                                                  // INVALID_COMMAND
  0x8021000C: '스캐너 설정이 맞지 않습니다. 해상도나 원고 위치를 바꿔 다시 시도해 주세요.',              // INCORRECT_HARDWARE_SETTING
  0x8021000D: '다른 프로그램이 스캐너를 쓰고 있습니다. 그 프로그램을 닫고 다시 시도해 주세요.',          // DEVICE_LOCKED
  0x8021000E: '스캐너 드라이버에서 오류가 났습니다. 스캐너 드라이버를 다시 설치해 보세요.',              // EXCEPTION_IN_DRIVER
  0x8021000F: '스캐너 드라이버의 응답이 올바르지 않습니다. 스캐너 드라이버를 다시 설치해 보세요.',       // INVALID_DRIVER_RESPONSE
  0x80210015: '스캐너를 찾을 수 없습니다. 전원 · 연결과 스캐너 드라이버 설치를 확인해 주세요.',          // S_NO_DEVICE_AVAILABLE
  0x80210016: '스캐너 덮개가 열려 있습니다. 덮개를 닫고 다시 시도해 주세요.',                           // COVER_OPEN
  0x80210017: '스캐너 램프가 꺼져 있습니다. 잠시 뒤에 다시 시도해 주세요.',                             // LAMP_OFF
  0x80210020: '종이가 여러 장 겹쳐 들어갔습니다. 원고를 가지런히 정리해 다시 넣어 주세요.',              // MULTI_FEED
  0x80040154: '이 Windows 에는 스캐너 기능(WIA)이 설치되어 있지 않습니다.',                              // REGDB_E_CLASSNOTREG
  0x80070422: 'Windows 이미지 획득(WIA) 서비스가 꺼져 있습니다. 서비스(services.msc)에서 켜 주세요.',   // ERROR_SERVICE_DISABLED
  0x80070426: 'Windows 이미지 획득(WIA) 서비스가 실행되고 있지 않습니다.',                               // ERROR_SERVICE_NOT_ACTIVE
  0x80070005: '스캐너에 접근할 권한이 없습니다.',                                                        // E_ACCESSDENIED
  0x80070015: '스캐너가 준비되지 않았습니다. 잠시 뒤에 다시 시도해 주세요.',                             // ERROR_NOT_READY
  0x8007000E: '메모리가 부족합니다. 해상도를 낮춰 다시 시도해 주세요.',                                  // E_OUTOFMEMORY
  0x80070070: '디스크 공간이 부족합니다.'                                                                // ERROR_DISK_FULL
};
// 사용자가 스캐너(드라이버 창 · 복합기 버튼)에서 취소한 경우
const CANCEL_CODES = [
  0x80210064, // WIA 전송 취소 (Transfer 중 취소하면 나온다)
  0x80004004, // E_ABORT
  0x800704C7  // HRESULT_FROM_WIN32(ERROR_CANCELLED)
];

function parseHResult(v) {
  if (typeof v === 'number' && isFinite(v)) return v >>> 0;
  if (typeof v === 'string' && /^\s*(0x)?[0-9a-f]{1,8}\s*$/i.test(v)) return parseInt(v.trim().replace(/^0x/i, ''), 16) >>> 0;
  if (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v)) return Number(v) >>> 0;
  return null;
}

const hex = (n) => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0');

// → { message, cancelled, code }
function wiaErrorMessage(hresult, rawMessage) {
  const code = parseHResult(hresult);
  if (code !== null && CANCEL_CODES.indexOf(code) >= 0) return { message: CANCELLED_MESSAGE, cancelled: true, code };
  if (code !== null && WIA_MESSAGES[code]) return { message: WIA_MESSAGES[code], cancelled: false, code };
  const raw = typeof rawMessage === 'string' ? rawMessage.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  return {
    message: '스캔하지 못했습니다.' + (raw ? ' ' + raw : '') + (code !== null ? ' (' + hex(code) + ')' : ''),
    cancelled: false,
    code
  };
}

/* ── 한 줄에 JSON 하나 (stdout) ────────────────────────── */
function createLineParser(onObject, onBadLine) {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  let first = true;
  const MAX_LINE = 1024 * 1024;
  function handle(line) {
    if (first) { first = false; line = line.replace(/^﻿/, ''); }
    line = line.replace(/\r$/, '').trim();
    if (!line) return;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { if (onBadLine) onBadLine(line); return; }
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) onObject(obj);
    else if (onBadLine) onBadLine(line);
  }
  return {
    push(chunk) {
      buf += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        handle(line);
      }
      if (buf.length > MAX_LINE) { if (onBadLine) onBadLine(buf.slice(0, 200)); buf = ''; }
    },
    end() {
      buf += decoder.end();
      if (buf) { const rest = buf; buf = ''; handle(rest); }
    }
  };
}

/* ── 장치 목록 정리 ───────────────────────────────────── */
function sanitizeDevices(list) {
  if (list && typeof list === 'object' && !Array.isArray(list)) list = [list]; // PowerShell 이 한 개짜리 배열을 풀어 버린 경우
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const d of list) {
    if (!d || typeof d !== 'object') continue;
    const id = typeof d.id === 'string' ? d.id : '';
    if (!id || id.length > DEVICE_ID_MAX || /[\u0000-\u001f\u007f]/.test(id) || seen.has(id)) continue;
    seen.add(id);
    let name = typeof d.name === 'string' ? d.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) : '';
    if (!name) name = '이름 없는 스캐너';
    const feeder = d.feeder === true;
    const flatbed = d.flatbed === false && feeder ? false : true;
    out.push({ id, name, feeder, flatbed });
    if (out.length >= 50) break;
  }
  return out;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function stamp(d) {
  return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}

/* ── 스캐너 ───────────────────────────────────────────── */
/**
 * @param {object} o
 * @param {() => (string|null)} o.powershell  실행할 powershell.exe 경로 (지원하지 않는 환경이면 null)
 * @param {() => string} o.tempDir            임시 폴더
 * @param {object} [o.limits]                 DEFAULTS 덮어쓰기 (시험용)
 */
function createScanner(o) {
  const limits = Object.assign({}, DEFAULTS, o.limits || {});
  let job = null;            // 진행 중인 스캔 { child, cancelled }
  let listing = null;        // 진행 중인 장치 목록 Promise

  async function makeWorkDir() {
    const base = o.tempDir();
    await fsp.mkdir(base, { recursive: true });
    return fsp.mkdtemp(path.join(base, 'autocroper-wia-'));
  }

  async function removeDir(dir) {
    if (!dir) return;
    for (let i = 0; i < 5; i++) {
      try { await fsp.rm(dir, { recursive: true, force: true }); return; } catch (_) {
        await new Promise((r) => setTimeout(r, 300)); // Windows: 방금 끝난 프로세스가 아직 파일을 쥐고 있을 수 있다
      }
    }
  }

  /**
   * PowerShell 스크립트 실행. onEvent(obj) 는 JSON 줄마다.
   * → Promise<{ code, signal, stderr, timedOut, killed, events }>
   */
  function run(exe, scriptPath, args, { onEvent, onSpawn, timeout }) {
    return new Promise((resolve) => {
      const events = [];
      let stderr = '';
      let timedOut = false;
      let killed = false;
      let settled = false;
      let child;
      const fullArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath].concat(args);
      try {
        child = spawn(exe, fullArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        resolve({ code: null, signal: null, stderr: String((err && err.message) || err), timedOut, killed, events, spawnError: true });
        return;
      }
      const kill = () => { killed = true; try { child.kill('SIGKILL'); } catch (_) { /* 이미 끝남 */ } };
      const timer = { t: null, deadline: 0 };
      const arm = (ms) => {
        clearTimeout(timer.t);
        timer.deadline = Date.now() + ms;
        timer.t = setTimeout(() => { timedOut = true; kill(); }, Math.max(0, ms));
      };
      arm(timeout(null));
      const parser = createLineParser((obj) => {
        events.push(obj);
        const next = timeout(obj, timer.deadline);
        if (typeof next === 'number') arm(next);
        if (onEvent) { try { onEvent(obj); } catch (_) { /* 무시 */ } }
      });
      child.stdout.on('data', (c) => parser.push(c));
      child.stderr.on('data', (c) => { if (stderr.length < 8000) stderr += c.toString('utf8'); });
      const done = (code, signal, spawnError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer.t);
        parser.end();
        resolve({ code, signal, stderr: stderr.trim(), timedOut, killed, events, spawnError: !!spawnError });
      };
      child.on('error', (err) => { stderr += String((err && err.message) || err); done(null, null, true); });
      child.on('close', (code, signal) => done(code, signal, false));
      if (onSpawn) onSpawn({ kill, child });
    });
  }

  async function writeScript(dir, name, text) {
    const p = path.join(dir, name);
    await fsp.writeFile(p, scriptBytes(text));
    return p;
  }

  function processFailure(r) {
    if (r.spawnError) return 'PowerShell 을 실행하지 못했습니다. ' + (r.stderr || '').slice(0, 200);
    return 'PowerShell 스크립트가 실패했습니다.' + (r.code !== null && r.code !== undefined ? ' (종료 코드 ' + r.code + ')' : '') +
      (r.stderr ? ' ' + r.stderr.replace(/\s+/g, ' ').slice(0, 300) : '');
  }

  /* 장치 목록 → { ok, devices?, error? } */
  async function listDevices() {
    if (job) return { ok: false, error: '스캔하는 중에는 스캐너 목록을 새로 고칠 수 없습니다.' };
    const exe = o.powershell();
    if (!exe) return { ok: false, error: '스캐너 직접 연결은 Windows 에서만 쓸 수 있습니다.' };
    if (listing) return listing;
    listing = (async () => {
      let dir = null;
      try {
        dir = await makeWorkDir();
        const script = await writeScript(dir, 'list-devices.ps1', LIST_DEVICES_PS1);
        const r = await run(exe, script, [], { timeout: (ev) => (ev ? undefined : limits.listTimeout) });
        if (r.timedOut) return { ok: false, error: '스캐너 목록을 가져오는 데 너무 오래 걸립니다. 스캐너 전원과 연결을 확인해 주세요.' };
        const res = r.events.filter((e) => typeof e.ok === 'boolean').pop();
        if (!res) return { ok: false, error: processFailure(r) };
        if (!res.ok) return { ok: false, error: wiaErrorMessage(res.hresult, res.message).message };
        return { ok: true, devices: sanitizeDevices(res.devices) };
      } catch (err) {
        return { ok: false, error: '스캐너 목록을 가져오지 못했습니다. ' + String((err && err.message) || err) };
      } finally {
        await removeDir(dir);
        listing = null;
      }
    })();
    return listing;
  }

  async function readPages(outDir, pages, when) {
    const files = [];
    let total = 0;
    let dropped = 0;
    const base = stamp(when);
    for (const pg of pages) {
      const fileName = path.basename(String(pg.file || ''));
      const ext = path.extname(fileName).toLowerCase();
      if (ext !== '.png' && ext !== '.bmp') continue;
      const p = path.join(outDir, fileName);
      try {
        const st = await fsp.stat(p);
        if (!st.isFile() || st.size === 0) continue;
        if (st.size > limits.fileBytes || total + st.size > limits.totalBytes) { dropped++; continue; }
        const buf = await fsp.readFile(p);
        total += buf.byteLength;
        files.push({
          name: '스캔_' + base + '_' + (files.length + 1) + ext,
          type: ext === '.png' ? 'image/png' : 'image/bmp',
          data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
        });
      } catch (_) { /* 읽지 못한 장은 건너뛴다 */ }
    }
    return { files, dropped };
  }

  /* 스캔 → { ok, files?, error?, cancelled? } */
  async function scan(opts, onProgress) {
    const v = validateScanOptions(opts);
    if (!v.ok) return { ok: false, error: v.error };
    if (job) return { ok: false, error: '이미 스캔 중입니다.' };
    if (listing) return { ok: false, error: '스캐너 목록을 가져오는 중입니다. 잠시 뒤에 다시 시도해 주세요.' };
    const exe = o.powershell();
    if (!exe) return { ok: false, error: '스캐너 직접 연결은 Windows 에서만 쓸 수 있습니다.' };
    const { deviceId, source, dpi, color } = v.value;
    const feeder = source === 'feeder';
    const progress = (p) => { if (onProgress) { try { onProgress(p); } catch (_) { /* 무시 */ } } };
    const thisJob = { kill: null, cancelled: false };
    job = thisJob;
    const when = new Date();
    let dir = null;
    try {
      dir = await makeWorkDir();
      const outDir = path.join(dir, 'out');
      await fsp.mkdir(outDir);
      const script = await writeScript(dir, 'scan.ps1', SCAN_PS1);
      const jobFile = path.join(dir, 'job.json');
      await fsp.writeFile(jobFile, JSON.stringify({ deviceId, source, dpi, color, outDir, maxPages: feeder ? MAX_PAGES : 1 }), 'utf8');
      if (thisJob.cancelled) return { ok: false, cancelled: true, error: CANCELLED_MESSAGE };

      const start = Date.now();
      const pages = [];
      const timeout = (ev, deadline) => {
        if (!ev) return feeder ? limits.feederTimeout : limits.flatbedTimeout;
        if (!feeder || ev.type !== 'page') return undefined;
        const now = Date.now();
        const next = Math.min(start + limits.feederHardCap, Math.max(deadline, now + limits.feederPerPage));
        return next - now;
      };
      progress({ state: 'scanning' });
      const r = await run(exe, script, ['-JobFile', jobFile], {
        timeout,
        onSpawn: ({ kill }) => { thisJob.kill = kill; if (thisJob.cancelled) kill(); },
        onEvent: (ev) => {
          if (ev.type === 'page' && Number.isInteger(ev.page) && ev.page > 0 && typeof ev.file === 'string') {
            pages.push(ev);
            progress({ state: 'page', page: pages.length });
          }
        }
      });

      const { files, dropped } = await readPages(outDir, pages, when);
      const withFiles = (res) => (files.length ? Object.assign(res, { files }) : res);

      if (thisJob.cancelled) return withFiles({ ok: false, cancelled: true, error: CANCELLED_MESSAGE });
      if (r.timedOut) {
        return withFiles({ ok: false, error: '스캐너가 응답하지 않아 스캔을 멈췄습니다.' + (files.length ? ' 그때까지 스캔한 ' + files.length + '장은 가져왔습니다.' : '') });
      }
      const err = r.events.filter((e) => e.type === 'error').pop();
      if (err) {
        const m = wiaErrorMessage(err.hresult, err.message);
        const res = { ok: false, error: m.message + (files.length ? ' (그 전까지 스캔한 ' + files.length + '장은 가져왔습니다.)' : '') };
        if (m.cancelled) res.cancelled = true;
        return withFiles(res);
      }
      const done = r.events.some((e) => e.type === 'done');
      if (!done && !files.length) return { ok: false, error: processFailure(r) };
      if (!files.length) {
        return { ok: false, error: dropped ? '스캔한 이미지가 너무 커서 가져오지 못했습니다. 해상도를 낮춰 주세요.' : '스캔한 이미지가 없습니다.' };
      }
      const res = { ok: true, files };
      if (dropped) res.error = '스캔한 이미지가 너무 커서 ' + files.length + '장만 가져왔습니다. 해상도를 낮춰 나눠 스캔해 주세요.';
      return res;
    } catch (e) {
      return { ok: false, error: '스캔하지 못했습니다. ' + String((e && e.message) || e) };
    } finally {
      if (job === thisJob) job = null;
      await removeDir(dir);
    }
  }

  function cancel() {
    if (!job) return;
    job.cancelled = true;
    if (job.kill) job.kill();
  }

  return { listDevices, scan, cancel, busy: () => !!job };
}

module.exports = {
  createScanner, validateScanOptions, sanitizeScanSettings, sanitizeDevices, wiaErrorMessage, parseHResult,
  createLineParser, stamp, SOURCES, DPIS, COLORS, MAX_PAGES, CANCELLED_MESSAGE
};
