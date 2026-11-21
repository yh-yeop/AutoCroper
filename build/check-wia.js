'use strict';
/* CI(windows-latest) 확인: desktop/wia-scripts.js 의 PowerShell 스크립트를 진짜 powershell.exe 로 돌려 본다.
 *  1) 세 스크립트 모두 PowerShell 파서로 구문 검사 → 오류가 있으면 실패
 *  2) 장치 목록 스크립트 실행 → exit 0 + 올바른 JSON({ ok: boolean, ... }) 이 아니면 실패
 *     (러너에는 스캐너가 없으니 빈 목록이나 'WIA 없음' 같은 ok:false JSON 은 통과)
 *  3) 스캔 스크립트를 없는 장치로 실행 → exit 0 + type:'error' JSON 이 아니면 실패
 * 사용: node build/check-wia.js   (Windows 가 아니면 건너뛴다) */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { LIST_DEVICES_PS1, SCAN_PS1, PARSE_CHECK_PS1, scriptBytes } = require('../desktop/wia-scripts');

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

try {
  const list = write('list-devices.ps1', LIST_DEVICES_PS1);
  const scan = write('scan.ps1', SCAN_PS1);
  const parse = write('parse-check.ps1', PARSE_CHECK_PS1);

  // 1) 구문 검사
  let r = run(parse, [list, scan, parse], 120000);
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
  fs.writeFileSync(job, JSON.stringify({ deviceId: '{00000000-0000-0000-0000-000000000000}\\9999', source: 'flatbed', dpi: 300, color: 'color', outDir, maxPages: 1 }));
  r = run(scan, ['-JobFile', job], 180000);
  const err = r.objs.filter((o) => o.type === 'error').pop();
  if (r.error || r.status !== 0) fail('스캔 스크립트가 0 이 아닌 코드로 끝났습니다.');
  else if (r.bad.length) fail('스캔 스크립트가 JSON 이 아닌 줄을 냈습니다: ' + r.bad.join(' | '));
  else if (!err || typeof err.hresult !== 'string' || !/^0x[0-9A-F]{8}$/.test(err.hresult)) fail('스캔 스크립트가 오류 JSON 을 내지 않았습니다.');
  else console.log('없는 장치 스캔 → ' + err.hresult + ' (' + err.stage + ')');
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 무시 */ }
}

if (failed) process.exit(1);
console.log('WIA 스크립트 확인 통과');
