'use strict';
/* 자동 업데이트 (electron-updater + GitHub Releases).
 * 패키징된 앱에서만 동작한다. 서명하지 않은 앱이므로 publisherName 을 두지 않아 서명 검사는 건너뛴다.
 * 상태는 { state, version?, percent?, message? } 로 렌더러에 보낸다.
 * state: 'checking' | 'available' | 'none' | 'downloading' | 'downloaded' | 'error' */

const { app } = require('electron');

const FIRST_CHECK_DELAY = 10 * 1000;          // 창이 뜨고 10초 뒤
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;    // 그 뒤 6시간마다

function createUpdater({ send }) {
  let last = null;            // 마지막 상태 (늦게 구독한 렌더러에게도 준다)
  let updater = null;         // electron-updater 의 autoUpdater (패키징된 앱에서만)
  let checking = null;        // 진행 중인 확인 Promise
  let started = false;
  let lastPercent = -1;
  let waiters = [];           // 메뉴의 '업데이트 확인' 결과를 기다리는 콜백

  function emit(status) {
    last = status;
    try { send(status); } catch (_) { /* 창이 없으면 무시 */ }
    if (status.state !== 'checking' && status.state !== 'downloading' && waiters.length) {
      const ws = waiters; waiters = [];
      ws.forEach((fn) => { try { fn(status); } catch (_) { /* 무시 */ } });
    }
  }

  function quietLog(...args) {
    console.warn('[업데이트]', ...args);
  }

  function setup() {
    if (updater || !app.isPackaged) return updater;
    try {
      ({ autoUpdater: updater } = require('electron-updater'));
    } catch (err) {
      quietLog('electron-updater 를 불러오지 못했습니다:', err && err.message);
      return null;
    }
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.logger = { info() {}, debug() {}, warn: quietLog, error: quietLog };

    updater.on('checking-for-update', () => emit({ state: 'checking' }));
    updater.on('update-available', (info) => {
      lastPercent = -1;
      emit({ state: 'available', version: info && info.version });
    });
    updater.on('update-not-available', (info) => emit({ state: 'none', version: (info && info.version) || app.getVersion() }));
    updater.on('download-progress', (p) => {
      const percent = Math.max(0, Math.min(100, Math.floor((p && p.percent) || 0)));
      if (percent === lastPercent) return; // 1% 단위로만 알린다
      lastPercent = percent;
      emit({ state: 'downloading', percent, version: last && last.version });
    });
    updater.on('update-downloaded', (info) => emit({ state: 'downloaded', version: info && info.version }));
    updater.on('error', (err) => {
      quietLog(err && (err.stack || err.message || err));
      emit({ state: 'error', message: '업데이트를 확인하지 못했습니다. 인터넷 연결을 확인해 주세요.' });
    });
    return updater;
  }

  // 대화 상자 없이 확인만 한다. 실패는 'error' 상태로만 알린다.
  function check() {
    if (!app.isPackaged) {
      emit({ state: 'none', version: app.getVersion(), message: '개발 모드에서는 업데이트를 확인하지 않습니다.' });
      return Promise.resolve();
    }
    const u = setup();
    if (!u) {
      emit({ state: 'error', message: '업데이트 기능을 사용할 수 없습니다.' });
      return Promise.resolve();
    }
    // 이미 받아 둔 업데이트가 있으면 다시 받지 않고 그 상태를 알린다.
    if (last && last.state === 'downloaded') { emit(last); return Promise.resolve(); }
    if (checking) return checking;
    const before = last;
    checking = Promise.resolve()
      .then(() => u.checkForUpdates())
      .then(() => {
        // 이벤트 없이 끝난 경우(확인을 건너뜀 등) 화면이 '확인 중'에 머물지 않게
        if (last === before || (last && last.state === 'checking')) emit({ state: 'none', version: app.getVersion() });
      })
      .catch((err) => {
        if (!last || last.state !== 'error') {
          quietLog(err && (err.message || err));
          emit({ state: 'error', message: '업데이트를 확인하지 못했습니다. 인터넷 연결을 확인해 주세요.' });
        }
      })
      .finally(() => { checking = null; });
    return checking;
  }

  // 창이 처음 보인 뒤 한 번만 부른다: 10초 뒤 확인, 그 뒤 6시간마다.
  function start() {
    if (started || !app.isPackaged) return;
    started = true;
    setTimeout(() => {
      check();
      const timer = setInterval(() => {
        if (last && last.state === 'downloaded') return; // 받아 둔 업데이트는 종료할 때 설치
        check();
      }, CHECK_INTERVAL);
      if (timer.unref) timer.unref();
    }, FIRST_CHECK_DELAY).unref?.();
  }

  // 받아 둔 업데이트가 있을 때만 앱을 끄고 설치한다.
  function install() {
    if (!updater || !last || last.state !== 'downloaded') return false;
    setImmediate(() => {
      try { updater.quitAndInstall(false, true); } catch (err) { quietLog(err && err.message); }
    });
    return true;
  }

  // 메뉴용: 확인하고 끝난 상태(none/available/downloaded/error)를 돌려준다.
  function checkAndWait() {
    return new Promise((resolve) => {
      waiters.push(resolve);
      check().then(() => {
        // 이벤트 없이 끝난 경우 대비
        setTimeout(() => {
          if (waiters.includes(resolve)) {
            waiters = waiters.filter((w) => w !== resolve);
            resolve(last || { state: 'none', version: app.getVersion() });
          }
        }, 1500);
      });
    });
  }

  return {
    start,
    check,
    checkAndWait,
    install,
    status: () => last
  };
}

module.exports = { createUpdater };
