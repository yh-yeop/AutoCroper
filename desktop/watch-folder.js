'use strict';
/* 감시 폴더: 스캐너 프로그램(복합기 'PC로 스캔' 등)이 저장하는 폴더를 지켜보다가 새 이미지가 다 쓰이면 넘겨준다.
 * - fs.watch 는 네트워크 드라이브 등에서 믿을 수 없어서 2초마다 폴더를 다시 읽는 것과 함께 쓴다.
 * - 감시를 시작할 때 이미 있던 파일은 무시한다.
 * - 크기 · 수정 시각이 1.5초 넘게 그대로이고 열어서 읽을 수 있어야 '다 쓴 파일'로 본다 (스캐너 프로그램은 조금씩 쓴다).
 * - 같은 파일은 경로 + 수정 시각으로 한 번만 넘긴다. 이 앱이 저장한 결과(…_crop.png 등)는 건너뛴다.
 * - TIFF 는 Chromium 이 열 수 없어서 건너뛴다 (스캐너 프로그램 저장 형식을 JPG · PNG 로 바꾸라고 안내).
 * Electron 에 기대지 않아 Node 만으로 시험할 수 있다. */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const WATCH_EXTS = ['.jpg', '.jpeg', '.png', '.bmp', '.webp', '.gif'];
const OWN_OUTPUT = /_crop(_\d+)?( \(\d+\))?\.(jpe?g|png)$/i;

function isWatchCandidate(name) {
  if (typeof name !== 'string' || !name) return false;
  if (name.startsWith('.') || name.startsWith('~$')) return false; // 숨김 · 임시 파일
  if (WATCH_EXTS.indexOf(path.extname(name).toLowerCase()) < 0) return false;
  return !OWN_OUTPUT.test(name);
}

const pathKey = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

/**
 * @param {object} o
 * @param {(paths: string[]) => void} o.onFiles  다 쓰인 새 이미지 경로들
 * @param {number} [o.intervalMs=2000]   폴더를 다시 읽는 간격
 * @param {number} [o.stableMs=1500]     크기 · 수정 시각이 이만큼 그대로여야 넘긴다
 * @param {number} [o.maxBytes=512MB]    이보다 큰 파일은 건너뛴다
 * @param {number} [o.maxBatch=500]      한 번에 넘기는 최대 개수
 * @param {boolean} [o.useFsWatch=true]
 */
function createFolderWatcher(o) {
  const intervalMs = o.intervalMs || 2000;
  const stableMs = o.stableMs || 1500;
  const maxBytes = o.maxBytes || 512 * 1024 * 1024;
  const maxBatch = o.maxBatch || 500;
  const useFsWatch = o.useFsWatch !== false;

  let folder = null;
  let gen = 0;               // start/stop 할 때마다 늘어난다 (끝난 감시의 비동기 작업을 버리려고)
  let watcher = null;
  let interval = null;
  let kick = null;
  let checking = false;
  let again = false;
  let seen = new Map();      // pathKey → 이미 넘겼거나(또는 시작 때 있던) 파일의 mtimeMs
  let pending = new Map();   // pathKey → { path, size, mtimeMs, since }

  function closeWatch() {
    if (watcher) { try { watcher.close(); } catch (_) { /* 무시 */ } }
    watcher = null;
  }

  function openWatch() {
    if (!useFsWatch || watcher || !folder) return;
    try {
      watcher = fs.watch(folder, { persistent: false }, () => schedule(300));
      watcher.on('error', () => closeWatch()); // 폴링이 계속 돈다. 다음 확인 때 다시 연다.
    } catch (_) {
      watcher = null;
    }
  }

  function schedule(ms) {
    if (!folder || kick) return;
    kick = setTimeout(() => { kick = null; check(); }, ms);
    if (kick.unref) kick.unref();
  }

  async function readable(p) {
    let fh = null;
    try {
      fh = await fsp.open(p, 'r');
      const b = Buffer.alloc(1);
      await fh.read(b, 0, 1, 0);
      return true;
    } catch (_) {
      return false;
    } finally {
      if (fh) { try { await fh.close(); } catch (_) { /* 무시 */ } }
    }
  }

  async function listCandidates(dir) {
    const names = await fsp.readdir(dir);
    return names.filter(isWatchCandidate).map((n) => path.join(dir, n));
  }

  async function check() {
    if (!folder) return;
    if (checking) { again = true; return; }
    checking = true;
    const myGen = gen;
    const dir = folder;
    try {
      let paths;
      try { paths = await listCandidates(dir); } catch (_) { closeWatch(); return; } // 폴더가 잠시 안 보임 (네트워크 등)
      if (myGen !== gen) return;
      openWatch();
      const present = new Set();
      const ready = [];
      for (const p of paths) {
        const key = pathKey(p);
        present.add(key);
        let st;
        try { st = await fsp.stat(p); } catch (_) { continue; }
        if (myGen !== gen) return;
        if (!st.isFile()) continue;
        if (seen.get(key) === st.mtimeMs) { pending.delete(key); continue; }
        if (st.size > maxBytes) { seen.set(key, st.mtimeMs); pending.delete(key); continue; }
        const now = Date.now();
        const prev = pending.get(key);
        if (!prev || prev.size !== st.size || prev.mtimeMs !== st.mtimeMs || st.size === 0) {
          pending.set(key, { path: p, size: st.size, mtimeMs: st.mtimeMs, since: now });
          continue;
        }
        if (now - prev.since < stableMs) continue;
        if (ready.length >= maxBatch) continue;
        if (!(await readable(p))) continue; // 아직 쓰는 중 — 다음에 다시
        if (myGen !== gen) return;
        seen.set(key, st.mtimeMs);
        pending.delete(key);
        ready.push(p);
      }
      // 사라진 파일은 잊는다
      for (const k of Array.from(pending.keys())) if (!present.has(k)) pending.delete(k);
      for (const k of Array.from(seen.keys())) if (!present.has(k)) seen.delete(k);
      if (ready.length) { try { o.onFiles(ready); } catch (_) { /* 무시 */ } }
      if (pending.size) schedule(stableMs + 100);
    } finally {
      checking = false;
      if (again) { again = false; schedule(50); }
    }
  }

  function stop() {
    gen++;
    folder = null;
    closeWatch();
    clearInterval(interval);
    clearTimeout(kick);
    interval = null;
    kick = null;
    pending = new Map();
    seen = new Map();
  }

  // 폴더를 읽지 못하면 throw 한다 (감시는 시작하지 않음).
  async function start(dir) {
    stop();
    const myGen = gen;
    const abs = path.resolve(dir);
    const st = await fsp.stat(abs);
    if (!st.isDirectory()) throw new Error('폴더가 아닙니다.');
    const initial = new Map();
    for (const p of await listCandidates(abs)) {
      try { initial.set(pathKey(p), (await fsp.stat(p)).mtimeMs); } catch (_) { /* 무시 */ }
    }
    if (myGen !== gen) return; // 그 사이에 stop / 다른 start
    seen = initial;
    folder = abs;
    openWatch();
    interval = setInterval(() => check(), intervalMs);
    if (interval.unref) interval.unref();
  }

  return { start, stop, folder: () => folder, check, _state: () => ({ seen, pending, watching: !!watcher }) };
}

module.exports = { createFolderWatcher, isWatchCandidate, OWN_OUTPUT, WATCH_EXTS };
