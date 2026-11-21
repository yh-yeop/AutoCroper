'use strict';
/* 스캐너 직접 연결 (Windows WIA). 네이티브 모듈 없이 powershell.exe 로 wia-scripts.js 의 스크립트를 돌린다.
 * Electron 에 기대지 않아 Node 만으로 시험할 수 있다. 실행 파일 경로 · 임시 폴더 · 시간 제한은 밖에서 넣는다.
 *
 * 속도: 스캔마다 PowerShell 을 새로 띄우고 장치에 다시 연결하면 그것만 몇 초가 든다. 그래서 '세션' 을 쓴다.
 *  - PowerShell 하나(SESSION_PS1)를 계속 띄워 두고 stdin/stdout 으로 한 줄에 JSON 하나씩 주고받는다.
 *    명령: {id, cmd:'list'} · {id, cmd:'warm', deviceId} · {id, cmd:'scan', ...job} · {id, cmd:'quit'}
 *    이벤트: 시작하면 {type:'ready'}, 그 뒤로는 모두 명령의 id 를 달고 온다.
 *  - 명령은 한 번에 하나만 보낸다(대기열). 장치 목록 · 스캔 · 미리 연결(warm) 모두 이 대기열을 지난다.
 *  - 세션은 처음 쓸 때(또는 main 이 창을 띄우고 몇 초 뒤 prewarm/warm 으로) 켜고, 오래 안 쓰면 끈다.
 *  - 세션이 켜지지 않거나 명령 도중 죽으면 예전처럼 스크립트를 한 번 실행하는 방식으로 대신한다.
 *    (스캔은 'scanning' 전에 죽었을 때만 대신한다: 급지대가 종이를 두 번 끌어가지 않게.) 다음에 쓸 때 세션을 다시 켠다.
 *  - 취소 · 시간 초과는 세션 프로세스를 죽인다. 세션은 다음에 쓸 때(취소 뒤에는 잠시 뒤 미리) 다시 켠다. */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { LIST_DEVICES_PS1, SCAN_PS1, SESSION_PS1, scriptBytes } = require('./wia-scripts');

const SOURCES = ['flatbed', 'feeder'];
const DPIS = [150, 200, 300, 600];
const COLORS = ['color', 'gray'];
const AREAS = ['full', 'top2_3', 'top1_2'];   // 평판 스캔 범위: 전체 · 위쪽 2/3 · 위쪽 1/2 (폭은 항상 전체)
const DEVICE_ID_MAX = 500;
const MAX_PAGES = 100;

const DEFAULTS = {
  listTimeout: 90 * 1000,             // 장치 목록 (장치마다 Connect 해서 기능을 읽는다)
  flatbedTimeout: 5 * 60 * 1000,      // 평판 한 장
  feederTimeout: 10 * 60 * 1000,      // 급지대: 처음 10분
  feederPerPage: 3 * 60 * 1000,       //   한 장 받을 때마다 '지금부터 3분' 으로 늘린다
  feederHardCap: 60 * 60 * 1000,      //   그래도 최대 60분
  fileBytes: 512 * 1024 * 1024,       // 한 장
  totalBytes: 1024 * 1024 * 1024,     // 한 번 스캔에서 렌더러로 보내는 합계
  sessionStart: 30 * 1000,            // 세션 PowerShell 이 'ready' 를 낼 때까지
  warmTimeout: 60 * 1000,             // 미리 연결(warm) 한 번
  sessionIdle: 30 * 60 * 1000,        // 이만큼 안 쓰면 세션을 끈다 (다음에 쓸 때 다시 켠다)
  quitTimeout: 2000,                  // quit 뒤 이만큼 기다렸다가 강제로 끝낸다
  sessionMaxFailures: 2,              // 세션이 연달아 이만큼 켜지지 않으면 이번 실행 동안은 한 번 실행 방식만 쓴다
  rewarmDelay: 1500                   // 취소로 세션을 죽인 뒤 이만큼 있다가 다시 켜서 장치에 미리 연결
};

const CANCELLED_MESSAGE = '스캔을 취소했습니다.';

/* ── 입력 검사 ─────────────────────────────────────────── */
function validateScanOptions(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, error: '스캔 설정이 올바르지 않습니다.' };
  const { deviceId, source, dpi, color } = o;
  const area = o.area === undefined ? 'full' : o.area;
  if (typeof deviceId !== 'string' || !deviceId || deviceId.length > DEVICE_ID_MAX || /[\u0000-\u001f\u007f]/.test(deviceId)) {
    return { ok: false, error: '스캐너를 먼저 선택해 주세요.' };
  }
  if (typeof source !== 'string' || SOURCES.indexOf(source) < 0) return { ok: false, error: '원고 위치(평판 · 급지대)가 올바르지 않습니다.' };
  if (typeof dpi !== 'number' || DPIS.indexOf(dpi) < 0) return { ok: false, error: '해상도는 150 · 200 · 300 · 600 dpi 중에서 골라 주세요.' };
  if (typeof color !== 'string' || COLORS.indexOf(color) < 0) return { ok: false, error: '색상(컬러 · 흑백)이 올바르지 않습니다.' };
  if (typeof area !== 'string' || AREAS.indexOf(area) < 0) return { ok: false, error: '스캔 범위(전체 · 위쪽 2/3 · 위쪽 1/2)가 올바르지 않습니다.' };
  return { ok: true, value: { deviceId, source, dpi, color, area } };
}

function isDeviceId(v) {
  return typeof v === 'string' && !!v && v.length <= DEVICE_ID_MAX && !/[\u0000-\u001f\u007f]/.test(v);
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
  if (AREAS.indexOf(s.area) >= 0) out.area = s.area;
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

// 세션 stdin 으로 보내는 명령은 ASCII 만 쓴다 (한글 경로는 \uXXXX). PowerShell 쪽 입력 인코딩과 상관없이 안전하다.
function encodeCommand(obj) {
  return JSON.stringify(obj).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '\n';
}

const PS_FLAGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
const SESSION_PREFIX = 'autocroper-wia-session-';
const noop = () => {};

/* ── 스캐너 ───────────────────────────────────────────── */
/**
 * @param {object} o
 * @param {() => (string|null)} o.powershell  실행할 powershell.exe 경로 (지원하지 않는 환경이면 null)
 * @param {() => string} o.tempDir            임시 폴더
 * @param {object} [o.limits]                 DEFAULTS 덮어쓰기 (시험용)
 * @param {boolean} [o.session=true]          계속 띄워 두는 PowerShell 세션을 쓸지 (false 면 매번 스크립트를 실행)
 */
function createScanner(o) {
  const limits = Object.assign({}, DEFAULTS, o.limits || {});
  const useSession = o.session !== false;
  let job = null;            // 진행 중인 스캔 { kill, cancelled, mode: null | 'session' | 'oneshot', deviceId }
  let listing = null;        // 진행 중인 장치 목록 Promise
  let sess = null;           // 지금 세션 (아래 startSession)
  let sessFailures = 0;      // 세션이 연달아 켜지지 않은 횟수
  let sweptOld = false;      // 지난 실행에서 남은 세션 폴더를 지웠는지
  let queue = Promise.resolve(); // 스캐너 명령은 한 번에 하나
  const warming = new Map(); // deviceId → 진행 중인 warm Promise
  let lastDevice = null;     // 마지막으로 쓰거나 미리 연결한 장치 (취소 뒤 다시 미리 연결)
  let closed = false;        // shutdown 뒤
  let rewarmTimer = null;
  let idleTimer = null;
  let sessionsStarted = 0;

  const unref = (t) => { if (t && typeof t.unref === 'function') t.unref(); return t; };

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

  function enqueue(fn) {
    const p = queue.then(fn, fn);
    queue = p.then(noop, noop);
    return p;
  }

  /**
   * PowerShell 스크립트 한 번 실행. onEvent(obj) 는 JSON 줄마다.
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
      const fullArgs = PS_FLAGS.concat(['-File', scriptPath]).concat(args);
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

  /* ── 세션 (계속 띄워 두는 PowerShell) ───────────────────── */
  // s.state: 'starting' → 'ready' → 'dead'
  function startSession(exe) {
    const s = { state: 'starting', child: null, dir: null, cmd: null, nextId: 1, stderr: '', killedByUs: false, code: null, signal: null, counted: false };
    sessionsStarted++;
    s.closed = new Promise((r) => { s.markClosed = r; });
    s.ready = (async () => {
      const base = o.tempDir();
      await fsp.mkdir(base, { recursive: true });
      let old = [];
      if (!sweptOld) {
        sweptOld = true;
        try { old = (await fsp.readdir(base)).filter((n) => n.startsWith(SESSION_PREFIX)); } catch (_) { old = []; }
      }
      s.dir = await fsp.mkdtemp(path.join(base, SESSION_PREFIX));
      // 지난 실행(앱이 갑자기 꺼진 경우)에서 남은 세션 폴더
      for (const n of old) removeDir(path.join(base, n)).catch(noop);
      const script = await writeScript(s.dir, 'session.ps1', SESSION_PS1);
      if (s.killedByUs) throw new Error('stopped');
      await new Promise((resolve, reject) => {
        let child;
        try {
          child = spawn(exe, PS_FLAGS.concat(['-File', script]), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (err) { reject(err); return; }
        s.child = child;
        const timer = setTimeout(() => { reject(new Error('session start timeout')); killSession(s); }, limits.sessionStart);
        s.onReady = () => { clearTimeout(timer); resolve(); };
        s.onStartFail = (err) => { clearTimeout(timer); reject(err); };
        child.stdin.on('error', noop); // 죽은 프로세스에 쓰면 EPIPE
        const parser = createLineParser((obj) => onSessionEvent(s, obj));
        child.stdout.on('data', (c) => parser.push(c));
        child.stderr.on('data', (c) => { s.stderr = (s.stderr + c.toString('utf8')).slice(-8000); });
        let ended = false;
        const end = (code, signal, err) => {
          if (ended) return;
          ended = true;
          parser.end();
          s.code = code;
          s.signal = signal;
          if (err) s.stderr += String((err && err.message) || err);
          onSessionClosed(s);
        };
        child.on('error', (err) => end(null, null, err));
        child.on('close', (code, signal) => end(code, signal));
      });
    })();
    s.ready.catch(() => { if (!s.child) onSessionClosed(s); }); // 프로세스를 띄우기도 전에 실패
    return s;
  }

  function onSessionEvent(s, obj) {
    if (s.state === 'starting') {
      if (obj.type === 'ready') { s.state = 'ready'; s.info = obj; s.onReady(); }
      return;
    }
    if (s.cmd && obj.id === s.cmd.id) s.cmd.onEvent(obj);
  }

  function onSessionClosed(s) {
    if (s.state === 'dead') return;
    const was = s.state;
    s.state = 'dead';
    if (sess === s) sess = null;
    if (was === 'starting' && s.onStartFail) s.onStartFail(new Error('session exited (' + s.code + ') ' + s.stderr.trim().slice(0, 200)));
    if (s.cmd) s.cmd.onDeath();
    removeDir(s.dir).catch(noop);
    s.markClosed();
  }

  function killSession(s) {
    if (!s || s.state === 'dead') return;
    s.killedByUs = true;
    if (s.child) { try { s.child.kill('SIGKILL'); } catch (_) { /* 이미 끝남 */ } }
  }

  // quit 을 보내고 기다린다. 명령을 처리하는 중이거나 아직 켜지는 중이면 바로 죽인다.
  function quitSession(s) {
    if (!s) return Promise.resolve();
    if (sess === s) sess = null;
    if (s.state === 'dead') return s.closed;
    if (s.state === 'ready' && !s.cmd) {
      s.killedByUs = true;
      try { s.child.stdin.write(encodeCommand({ id: 0, cmd: 'quit' })); s.child.stdin.end(); } catch (_) { /* 무시 */ }
      const t = unref(setTimeout(() => killSession(s), limits.quitTimeout));
      s.closed.then(() => clearTimeout(t));
    } else {
      killSession(s);
    }
    return s.closed;
  }

  function armIdle(s) {
    clearTimeout(idleTimer);
    idleTimer = unref(setTimeout(() => { if (sess === s && !s.cmd) quitSession(s); }, limits.sessionIdle));
  }

  // 켜져 있는 세션, 또는 새로 켠 세션. 쓸 수 없으면 null (그러면 한 번 실행 방식으로 대신한다).
  async function getSession() {
    if (!useSession || closed || sessFailures >= limits.sessionMaxFailures) return null;
    const exe = o.powershell();
    if (!exe) return null;
    if (!sess) sess = startSession(exe);
    const s = sess;
    try {
      await s.ready;
    } catch (_) {
      if (!s.killedByUs && !s.counted) { s.counted = true; sessFailures++; }
      return null;
    }
    if (s.state !== 'ready') return null;
    sessFailures = 0;
    if (!s.cmd) armIdle(s);
    return s;
  }

  /**
   * 세션에 명령 하나. isTerminal(ev) 인 이벤트가 오면 끝. 시간이 지나면 세션을 죽인다.
   * → Promise<{ events, timedOut, died, killed, code, signal, stderr, sentAt }>
   */
  function sessionCommand(s, cmd, { timeout, isTerminal, onEvent }) {
    return new Promise((resolve) => {
      const res = { events: [], timedOut: false, died: false, killed: false, code: null, signal: null, stderr: '', spawnError: false, sentAt: Date.now() };
      if (!s || s.state !== 'ready' || s.cmd) { res.died = true; resolve(res); return; }
      clearTimeout(idleTimer);
      const id = s.nextId++;
      let timer = null;
      let deadline = 0;
      let settled = false;
      const arm = (ms) => {
        clearTimeout(timer);
        deadline = Date.now() + ms;
        timer = setTimeout(() => { res.timedOut = true; killSession(s); }, Math.max(0, ms));
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (s.cmd && s.cmd.id === id) s.cmd = null;
        if (s.state === 'ready' && sess === s) armIdle(s);
        resolve(res);
      };
      s.cmd = {
        id,
        onEvent: (obj) => {
          res.events.push(obj);
          const next = timeout(obj, deadline);
          if (typeof next === 'number') arm(next);
          if (onEvent) { try { onEvent(obj); } catch (_) { /* 무시 */ } }
          if (isTerminal(obj)) finish();
        },
        onDeath: () => {
          res.died = true;
          res.killed = s.killedByUs;
          res.code = s.code;
          res.signal = s.signal;
          res.stderr = s.stderr.trim();
          finish();
        }
      };
      arm(timeout(null));
      res.sentAt = Date.now();
      try { s.child.stdin.write(encodeCommand(Object.assign({ id }, cmd))); } catch (_) { killSession(s); }
    });
  }

  // 취소로 세션을 죽인 뒤: 잠시 있다가 세션을 다시 켜고 마지막 장치에 미리 연결해 둔다.
  function scheduleRewarm() {
    if (!useSession || closed) return;
    clearTimeout(rewarmTimer);
    rewarmTimer = unref(setTimeout(() => {
      if (!closed && !job && lastDevice) warm(lastDevice).catch(noop);
    }, limits.rewarmDelay));
  }

  /* 세션만 미리 켠다 → Promise<boolean> */
  function prewarm() {
    if (!useSession || closed || !o.powershell()) return Promise.resolve(false);
    return getSession().then((s) => !!s, () => false);
  }

  /* 장치에 미리 연결해 둔다 (다음 스캔이 연결을 건너뛴다) → Promise<{ ok, cached?, error? }> (reject 하지 않음) */
  function warm(deviceId) {
    if (!isDeviceId(deviceId)) return Promise.resolve({ ok: false, error: '스캐너를 먼저 선택해 주세요.' });
    lastDevice = deviceId;
    if (!useSession || closed || !o.powershell()) return Promise.resolve({ ok: false, error: '스캐너 세션을 쓸 수 없습니다.' });
    if (job) return Promise.resolve({ ok: false, error: '스캔하는 중입니다.' });
    if (warming.has(deviceId)) return warming.get(deviceId);
    const p = enqueue(async () => {
      if (job && job.deviceId !== deviceId) return { ok: false, error: '다른 스캐너로 스캔하는 중입니다.' };
      const s = await getSession();
      if (!s) return { ok: false, error: '스캐너 세션을 켜지 못했습니다.' };
      const r = await sessionCommand(s, { cmd: 'warm', deviceId }, {
        timeout: (ev) => (ev ? undefined : limits.warmTimeout),
        isTerminal: (e) => e.type === 'warm' || e.type === 'error'
      });
      const ev = r.events.filter((e) => e.type === 'warm').pop();
      if (ev && ev.ok === true) return { ok: true, cached: ev.cached === true };
      if (ev) return { ok: false, error: wiaErrorMessage(ev.hresult, ev.message).message };
      return { ok: false, error: r.timedOut ? '스캐너가 응답하지 않습니다.' : processFailure(r) };
    }).catch((err) => ({ ok: false, error: String((err && err.message) || err) }));
    warming.set(deviceId, p);
    p.then(() => { if (warming.get(deviceId) === p) warming.delete(deviceId); });
    return p;
  }

  /* 장치 목록 → { ok, devices?, error? } */
  function listResult(res) {
    if (!res.ok) return { ok: false, error: wiaErrorMessage(res.hresult, res.message).message };
    return { ok: true, devices: sanitizeDevices(res.devices) };
  }

  const LIST_TIMEOUT_ERROR = '스캐너 목록을 가져오는 데 너무 오래 걸립니다. 스캐너 전원과 연결을 확인해 주세요.';

  async function listOneShot(exe) {
    let dir = null;
    try {
      dir = await makeWorkDir();
      const script = await writeScript(dir, 'list-devices.ps1', LIST_DEVICES_PS1);
      const r = await run(exe, script, [], { timeout: (ev) => (ev ? undefined : limits.listTimeout) });
      if (r.timedOut) return { ok: false, error: LIST_TIMEOUT_ERROR };
      const res = r.events.filter((e) => typeof e.ok === 'boolean').pop();
      if (!res) return { ok: false, error: processFailure(r) };
      return listResult(res);
    } finally {
      await removeDir(dir);
    }
  }

  async function listDevices() {
    if (job) return { ok: false, error: '스캔하는 중에는 스캐너 목록을 새로 고칠 수 없습니다.' };
    const exe = o.powershell();
    if (!exe) return { ok: false, error: '스캐너 직접 연결은 Windows 에서만 쓸 수 있습니다.' };
    if (listing) return listing;
    listing = enqueue(async () => {
      try {
        const s = await getSession();
        if (s) {
          const r = await sessionCommand(s, { cmd: 'list' }, {
            timeout: (ev) => (ev ? undefined : limits.listTimeout),
            isTerminal: (e) => e.type === 'list' || e.type === 'error'
          });
          if (r.timedOut) return { ok: false, error: LIST_TIMEOUT_ERROR };
          const res = r.events.filter((e) => e.type === 'list' && typeof e.ok === 'boolean').pop();
          if (res) return listResult(res);
          // 세션이 죽었거나 명령을 알아듣지 못함 → 한 번 실행 방식으로
        }
        return await listOneShot(exe);
      } catch (err) {
        return { ok: false, error: '스캐너 목록을 가져오지 못했습니다. ' + String((err && err.message) || err) };
      } finally {
        listing = null;
      }
    });
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
      if (ext !== '.png' && ext !== '.bmp' && ext !== '.jpg') continue;
      const p = path.join(outDir, fileName);
      try {
        const st = await fsp.stat(p);
        if (!st.isFile() || st.size === 0) continue;
        if (st.size > limits.fileBytes || total + st.size > limits.totalBytes) { dropped++; continue; }
        const buf = await fsp.readFile(p);
        total += buf.byteLength;
        files.push({
          name: '스캔_' + base + '_' + (files.length + 1) + ext,
          type: ext === '.png' ? 'image/png' : ext === '.jpg' ? 'image/jpeg' : 'image/bmp',
          data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
        });
      } catch (_) { /* 읽지 못한 장은 건너뛴다 */ }
    }
    return { files, dropped };
  }

  /* 스캔 → { ok, files?, error?, cancelled?, timing? }
   * timing = { setupMs, scanMs, totalMs, waitMs, warm, session }
   *   setupMs: 명령을 보낸(스크립트를 띄운) 때 → 'scanning' (장치 연결 · 설정. 다시 연결했다면 그것까지)
   *   scanMs:  'scanning' → 마지막 'page' (스캔 · 전송 · 저장)
   *   totalMs: scan() 호출 → 결과 (대기열 · 세션 시작 · 파일 읽기 포함)
   *   waitMs:  scan() 호출 → 명령을 보낸 때 (앞 명령 · 세션 시작을 기다린 시간)
   *   warm:    장치 연결을 다시 쓰지 않고 이어 썼는지 · session: 세션으로 스캔했는지 */
  async function scan(opts, onProgress) {
    const v = validateScanOptions(opts);
    if (!v.ok) return { ok: false, error: v.error };
    if (job) return { ok: false, error: '이미 스캔 중입니다.' };
    if (listing) return { ok: false, error: '스캐너 목록을 가져오는 중입니다. 잠시 뒤에 다시 시도해 주세요.' };
    const exe = o.powershell();
    if (!exe) return { ok: false, error: '스캐너 직접 연결은 Windows 에서만 쓸 수 있습니다.' };
    const { deviceId, source, dpi, color, area } = v.value;
    const feeder = source === 'feeder';
    const progress = (p) => { if (onProgress) { try { onProgress(p); } catch (_) { /* 무시 */ } } };
    const thisJob = { kill: null, cancelled: false, mode: null, deviceId };
    job = thisJob;
    lastDevice = deviceId;
    const when = new Date();
    const t0 = Date.now();
    const tm = { sentAt: null, scanning: null, lastPage: null, warm: false, session: false };
    const span = (a, b) => (a !== null && b !== null && b >= a ? b - a : null);
    const withTiming = (res) => Object.assign(res, {
      timing: {
        setupMs: span(tm.sentAt, tm.scanning), scanMs: span(tm.scanning, tm.lastPage), totalMs: Date.now() - t0,
        waitMs: span(t0, tm.sentAt), warm: tm.warm, session: tm.session
      }
    });
    let dir = null;
    try {
      dir = await makeWorkDir();
      const outDir = path.join(dir, 'out');
      await fsp.mkdir(outDir);
      // 급지대는 장마다 길이가 다르니 범위를 줄이지 않는다 (줄이면 장 아래쪽이 잘린다)
      const work = { deviceId, source, dpi, color, area: feeder ? 'full' : area, outDir, maxPages: feeder ? MAX_PAGES : 1 };
      const pages = [];
      let started = false;
      const makeTimeout = (start) => (ev, deadline) => {
        if (!ev) return feeder ? limits.feederTimeout : limits.flatbedTimeout;
        if (!feeder || ev.type !== 'page') return undefined;
        const now = Date.now();
        const next = Math.min(start + limits.feederHardCap, Math.max(deadline, now + limits.feederPerPage));
        return next - now;
      };
      const onEvent = (ev) => {
        // 스캐너 연결 · 설정이 끝나 실제 스캔을 시작하는 순간(화면에서 '준비' 시간 계산용)
        if (ev.type === 'scanning') {
          if (!started) progress({ state: 'ready' });
          started = true;
          if (!pages.length) { tm.scanning = Date.now(); tm.warm = ev.warm === true; }
        }
        if (ev.type === 'page' && Number.isInteger(ev.page) && ev.page > 0 && typeof ev.file === 'string') {
          pages.push(ev);
          tm.lastPage = Date.now();
          progress({ state: 'page', page: pages.length });
        }
      };
      progress({ state: 'scanning' });

      const r = await enqueue(async () => {
        if (thisJob.cancelled) return null;
        const s = await getSession();
        if (thisJob.cancelled) return null;
        if (s) {
          thisJob.mode = 'session';
          tm.session = true;
          const sr = await sessionCommand(s, Object.assign({ cmd: 'scan' }, work), {
            timeout: makeTimeout(Date.now()), onEvent,
            isTerminal: (e) => e.type === 'done' || e.type === 'error'
          });
          tm.sentAt = sr.sentAt;
          if (!sr.died || sr.timedOut || thisJob.cancelled || started) return sr;
          // 세션이 스캔을 시작하기 전에 죽었다 → 한 번 실행 방식으로 (세션은 다음에 쓸 때 다시 켠다)
          tm.session = false; tm.scanning = null; tm.warm = false;
        }
        if (thisJob.cancelled) return null;
        thisJob.mode = 'oneshot';
        const script = await writeScript(dir, 'scan.ps1', SCAN_PS1);
        const jobFile = path.join(dir, 'job.json');
        await fsp.writeFile(jobFile, JSON.stringify(work), 'utf8');
        if (thisJob.cancelled) return null;
        tm.sentAt = Date.now();
        return run(exe, script, ['-JobFile', jobFile], {
          timeout: makeTimeout(tm.sentAt), onEvent,
          onSpawn: ({ kill }) => { thisJob.kill = kill; if (thisJob.cancelled) kill(); }
        });
      });
      if (!r) return withTiming({ ok: false, cancelled: true, error: CANCELLED_MESSAGE });

      const { files, dropped } = await readPages(outDir, pages, when);
      const withFiles = (res) => withTiming(files.length ? Object.assign(res, { files }) : res);

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
      if (!done && !files.length) return withTiming({ ok: false, error: processFailure(r) });
      if (!files.length) {
        return withTiming({ ok: false, error: dropped ? '스캔한 이미지가 너무 커서 가져오지 못했습니다. 해상도를 낮춰 주세요.' : '스캔한 이미지가 없습니다.' });
      }
      const res = { ok: true, files };
      if (dropped) res.error = '스캔한 이미지가 너무 커서 ' + files.length + '장만 가져왔습니다. 해상도를 낮춰 나눠 스캔해 주세요.';
      return withTiming(res);
    } catch (e) {
      return withTiming({ ok: false, error: '스캔하지 못했습니다. ' + String((e && e.message) || e) });
    } finally {
      if (job === thisJob) job = null;
      await removeDir(dir);
    }
  }

  // 스캔 취소: 한 번 실행 중이면 그 프로세스를, 세션으로 스캔 중이거나 대기열에서 기다리는 중이면 세션을 죽인다.
  function cancel() {
    if (!job) return;
    job.cancelled = true;
    if (job.kill) job.kill();
    if (job.mode !== 'oneshot' && sess) {
      killSession(sess);
      scheduleRewarm();
    }
  }

  /* 앱을 끌 때: 진행 중인 스캔을 멈추고 세션에 quit 을 보낸다 (안 끝나면 강제로). → Promise (세션이 끝나면) */
  function shutdown() {
    closed = true;
    clearTimeout(rewarmTimer);
    clearTimeout(idleTimer);
    if (job) { job.cancelled = true; if (job.kill) job.kill(); }
    return quitSession(sess);
  }

  function sessionInfo() {
    return {
      running: !!sess && sess.state === 'ready',
      pid: sess && sess.child ? sess.child.pid : null,
      started: sessionsStarted,
      failures: sessFailures
    };
  }

  return { listDevices, scan, cancel, warm, prewarm, shutdown, busy: () => !!job, sessionInfo };
}

module.exports = {
  createScanner, validateScanOptions, sanitizeScanSettings, sanitizeDevices, wiaErrorMessage, parseHResult, isDeviceId,
  createLineParser, encodeCommand, stamp, SOURCES, DPIS, COLORS, AREAS, MAX_PAGES, CANCELLED_MESSAGE
};
