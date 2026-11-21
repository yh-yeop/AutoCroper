'use strict';
/* CI(windows-latest) 확인: desktop/wia-scripts.js 의 PowerShell 스크립트를 진짜 powershell.exe 로 돌려 본다.
 *  1) 네 스크립트(목록 · 스캔 · 세션 · 구문 검사) 모두 PowerShell 파서로 구문 검사 → 오류가 있으면 실패
 *  2) 장치 목록 스크립트 실행 → exit 0 + 올바른 JSON({ ok: boolean, ... }) 이 아니면 실패
 *     (러너에는 스캐너가 없으니 빈 목록이나 'WIA 없음' 같은 ok:false JSON 은 통과)
 *  3) 스캔 스크립트를 없는 장치로 실행 → exit 0 + type:'error' JSON 이 아니면 실패
 *  4) 세션: 켜서 'ready' → list → warm(없는 장치) → scan(없는 장치) → 모르는 명령 → quit → exit 0
 *     명령을 하나 보내고 답을 받은 뒤에 다음을 보낸다(stdin 을 미리 다 읽어 버리지 않는지도 확인). 단계마다 시간 제한.
 *  5) 세션: stdin 을 닫으면(앱이 갑자기 꺼진 경우) 스스로 exit 0
 * 사용: node build/check-wia.js   (Windows 가 아니면 건너뛴다) */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { LIST_DEVICES_PS1, SCAN_PS1, SESSION_PS1, PARSE_CHECK_PS1, scriptBytes } = require('../desktop/wia-scripts');

if (process.platform !== 'win32') {
  console.log('Windows 가 아니어서 WIA 확인을 건너뜁니다.');
  process.exit(0);
}

const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autocroper-wia-check-'));
let failed = false;

function fail(msg) { console.error('::error::' + msg); failed = true; }

function write(name, text) {
  if (!/^[\x00-\x7f]*$/.test(text)) fail(name + ' 에 ASCII 가 아닌 글자가 있습니다.');
  const p = path.join(dir, name);
  fs.writeFileSync(p, scriptBytes(text));
  return p;
}

function run(script, args, timeoutMs) {
  const t = Date.now();
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script].concat(args || []), {
    encoding: 'utf8', timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  const lines = String(r.stdout || '').split(/\r?\n/).map((l) => l.replace(/^\uFEFF/, '').trim()).filter(Boolean);
  const objs = [];
  const bad = [];
  for (const l of lines) {
    try { const o = JSON.parse(l); if (o && typeof o === 'object' && !Array.isArray(o)) objs.push(o); else bad.push(l); } catch (_) { bad.push(l); }
  }
  console.log('— ' + path.basename(script) + ' (' + (Date.now() - t) + 'ms) 종료 코드 ' + r.status + (r.error ? ' / ' + r.error.message : ''));
  if (r.stdout) console.log('stdout:\n' + r.stdout.trim());
  if (r.stderr) console.log('stderr:\n' + r.stderr.trim());
  return { status: r.status, error: r.error, objs, bad, stderr: String(r.stderr || '') };
}

const FLAGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'];
const NO_DEVICE = '{00000000-0000-0000-0000-000000000000}\\9999';
const HRESULT = /^0x[0-9A-F]{8}$/;

// 세션 스크립트를 띄워 한 줄씩 주고받는다. 무엇을 기다리든 시간 제한이 있다.
function startSession(script) {
  const t0 = Date.now();
  const child = spawn(PS, FLAGS.concat([script]), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const s = { child, objs: [], bad: [], stdout: '', stderr: '', code: undefined, waiters: [] };
  let buf = '';
  child.stdin.on('error', () => {});
  child.stdout.on('data', (c) => {
    const text = c.toString('utf8');
    s.stdout += text;
    buf += text;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/^\uFEFF/, '').trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let o = null;
      try { o = JSON.parse(line); } catch (_) { o = null; }
      if (!o || typeof o !== 'object' || Array.isArray(o)) { s.bad.push(line); continue; }
      console.log('  <- ' + line.slice(0, 300) + ' (' + (Date.now() - t0) + 'ms)');
      s.objs.push(o);
      s.waiters.slice().forEach((w) => { if (w.pred(o)) w.done(null, o); });
    }
  });
  child.stderr.on('data', (c) => { s.stderr += c.toString('utf8'); });
  s.exited = new Promise((resolve) => {
    child.on('error', (err) => { s.stderr += String(err && err.message); });
    child.on('close', (code) => {
      s.code = code;
      s.waiters.slice().forEach((w) => w.done(new Error('세션이 먼저 끝났습니다 (종료 코드 ' + code + ')')));
      resolve(code);
    });
  });
  s.waitFor = (pred, ms, what) => new Promise((resolve, reject) => {
    const found = s.objs.find(pred);
    if (found) { resolve(found); return; }
    if (s.code !== undefined) { reject(new Error(what + ': 세션이 이미 끝났습니다')); return; }
    const w = {
      pred,
      done: (err, o) => {
        clearTimeout(timer);
        s.waiters.splice(s.waiters.indexOf(w), 1);
        if (err) reject(new Error(what + ': ' + err.message)); else resolve(o);
      }
    };
    const timer = setTimeout(() => w.done(new Error(ms + 'ms 안에 오지 않았습니다')), ms);
    s.waiters.push(w);
  });
  s.send = (o) => { console.log('  -> ' + JSON.stringify(o)); s.child.stdin.write(JSON.stringify(o) + '\n'); };
  s.waitExit = (ms) => Promise.race([s.exited, new Promise((r) => setTimeout(() => r('timeout'), ms))]);
  s.kill = () => { if (s.code === undefined) { try { child.kill(); } catch (_) { /* 무시 */ } } };
  return s;
}

async function checkSession(script, outDir) {
  console.log('— session.ps1 (명령 주고받기)');
  const s = startSession(script);
  try {
    const ready = await s.waitFor((o) => o.type === 'ready', 60000, 'ready');
    if (ready.version !== 1 || typeof ready.wia !== 'boolean') fail('ready 이벤트가 이상합니다: ' + JSON.stringify(ready));

    s.send({ id: 1, cmd: 'list' });
    const list = await s.waitFor((o) => o.id === 1 && o.type === 'list', 120000, 'list');
    if (typeof list.ok !== 'boolean') fail('list 결과에 ok 가 없습니다: ' + JSON.stringify(list));
    else if (list.ok && list.devices !== null && typeof list.devices !== 'object') fail('list devices 가 이상합니다: ' + JSON.stringify(list));
    else if (!list.ok && !HRESULT.test(String(list.hresult))) fail('list 오류에 hresult 가 없습니다: ' + JSON.stringify(list));

    s.send({ id: 2, cmd: 'warm', deviceId: NO_DEVICE });
    const w = await s.waitFor((o) => o.id === 2 && o.type === 'warm', 60000, 'warm');
    if (w.ok !== false || !HRESULT.test(String(w.hresult))) fail('없는 장치 warm 이 오류를 내지 않았습니다: ' + JSON.stringify(w));

    s.send({ id: 3, cmd: 'scan', deviceId: NO_DEVICE, source: 'flatbed', dpi: 300, color: 'color', area: 'top1_2', outDir, maxPages: 1 });
    const e = await s.waitFor((o) => o.id === 3 && (o.type === 'error' || o.type === 'done'), 60000, 'scan');
    if (e.type !== 'error' || !HRESULT.test(String(e.hresult))) fail('없는 장치 scan 이 오류를 내지 않았습니다: ' + JSON.stringify(e));

    s.send({ id: 4, cmd: 'bogus' });
    const u = await s.waitFor((o) => o.id === 4, 30000, '모르는 명령');
    if (u.type !== 'error' || u.stage !== 'command') fail('모르는 명령에 command 오류를 내지 않았습니다: ' + JSON.stringify(u));

    s.send({ id: 5, cmd: 'quit' });
    await s.waitFor((o) => o.id === 5 && o.type === 'bye', 20000, 'bye');
    const code = await s.waitExit(20000);
    if (code !== 0) fail('quit 뒤 세션이 0 으로 끝나지 않았습니다: ' + code);
  } catch (err) {
    fail('세션 확인 실패: ' + err.message);
  } finally {
    s.kill();
    await s.waitExit(5000);
    if (s.bad.length) fail('세션이 JSON 이 아닌 줄을 냈습니다: ' + s.bad.join(' | '));
    if (s.stderr.trim()) console.log('stderr:\n' + s.stderr.trim());
  }

  console.log('— session.ps1 (stdin 닫기)');
  const s2 = startSession(script);
  try {
    await s2.waitFor((o) => o.type === 'ready', 60000, 'ready');
    s2.child.stdin.end();
    const code = await s2.waitExit(20000);
    if (code !== 0) fail('stdin 을 닫은 뒤 세션이 0 으로 끝나지 않았습니다: ' + code);
  } catch (err) {
    fail('세션(stdin 닫기) 확인 실패: ' + err.message);
  } finally {
    s2.kill();
    await s2.waitExit(5000);
  }
}

(async () => {
try {
  const list = write('list-devices.ps1', LIST_DEVICES_PS1);
  const scan = write('scan.ps1', SCAN_PS1);
  const session = write('session.ps1', SESSION_PS1);
  const parse = write('parse-check.ps1', PARSE_CHECK_PS1);

  // 1) 구문 검사
  let r = run(parse, [list, scan, session, parse], 120000);
  const pc = r.objs.pop();
  if (r.status !== 0 || !pc || pc.ok !== true) fail('PowerShell 구문 검사 실패: ' + JSON.stringify(pc && pc.errors));

  // 2) 장치 목록
  r = run(list, [], 180000);
  const res = r.objs.filter((o) => typeof o.ok === 'boolean').pop();
  if (r.error || r.status !== 0) fail('장치 목록 스크립트가 0 이 아닌 코드로 끝났습니다.');
  else if (r.bad.length) fail('장치 목록 스크립트가 JSON 이 아닌 줄을 냈습니다: ' + r.bad.join(' | '));
  else if (!res) fail('장치 목록 스크립트가 결과 JSON 을 내지 않았습니다.');
  else if (res.ok && !Array.isArray(res.devices)) fail('devices 가 배열이 아닙니다: ' + JSON.stringify(res));
  else if (res.ok) console.log('WIA 사용 가능 · 스캐너 ' + res.devices.length + '대');
  else console.log('WIA 를 쓸 수 없는 러너입니다 (괜찮음): ' + res.hresult + ' ' + (res.message || ''));

  // 3) 없는 장치로 스캔 → 깔끔한 오류 JSON
  const outDir = path.join(dir, 'out');
  fs.mkdirSync(outDir);
  const job = path.join(dir, 'job.json');
  fs.writeFileSync(job, JSON.stringify({ deviceId: NO_DEVICE, source: 'flatbed', dpi: 300, color: 'color', area: 'top2_3', outDir, maxPages: 1 }));
  r = run(scan, ['-JobFile', job], 180000);
  const err = r.objs.filter((o) => o.type === 'error').pop();
  if (r.error || r.status !== 0) fail('스캔 스크립트가 0 이 아닌 코드로 끝났습니다.');
  else if (r.bad.length) fail('스캔 스크립트가 JSON 이 아닌 줄을 냈습니다: ' + r.bad.join(' | '));
  else if (!err || typeof err.hresult !== 'string' || !/^0x[0-9A-F]{8}$/.test(err.hresult)) fail('스캔 스크립트가 오류 JSON 을 내지 않았습니다.');
  else console.log('없는 장치 스캔 → ' + err.hresult + ' (' + err.stage + ')');

  // 4) · 5) 세션
  await checkSession(session, outDir);
} catch (err) {
  fail('확인 중 예외: ' + (err && err.stack || err));
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 무시 */ }
}

if (failed) process.exit(1);
console.log('WIA 스크립트 확인 통과');
process.exit(0);
})();
