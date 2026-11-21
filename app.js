/* 흰 여백 자르기 — 모든 처리는 브라우저 안에서만 이뤄진다. */
(function () {
  'use strict';

  /* ───────────────────────── 코어 (UI와 무관) ─────────────────────────
   * 분석은 이미지당 한 번만 한다. 각 픽셀의 "흰색과의 차이"
   *   d = max(255-R, 255-G, 255-B) = 255 - min(R,G,B)
   * 를 0~127 구간(127 이상은 127)으로 묶어 행별 · 열별 히스토그램을 만들고,
   * 누적합으로 바꿔 둔다: rowCum[y*128 + t] = y행에서 d > t 인 픽셀 수.
   * 그러면 임계값 · 노이즈 필터를 바꿀 때마다 픽셀을 다시 볼 필요 없이
   * O(가로+세로)로 크롭 영역을 다시 계산할 수 있다.
   *
   * 아래 세 함수(accumulateStrip, toSuffix, buildHistograms)는 Web Worker
   * 안에서도 그대로 쓰이도록 문자열로 옮겨진다. 바깥 변수를 참조하지 말 것.
   */
  var NB = 128; // 히스토그램 칸 수 (임계값 최대 120 < 127)

  function accumulateStrip(data, w, rows, y0, rowHist, colHist, dmap) {
    var i = 0, k = y0 * w;
    for (var r = 0; r < rows; r++) {
      var rowBase = (y0 + r) * 128;
      for (var x = 0; x < w; x++, i += 4, k++) {
        var m = data[i], g = data[i + 1], b = data[i + 2];
        if (g < m) m = g;
        if (b < m) m = b;
        var d = 255 - m;
        dmap[k] = d;
        if (d > 4) { // 임계값 최소가 5이므로 d<=4 는 어떤 설정에서도 배경
          if (d > 127) d = 127;
          rowHist[rowBase + d]++;
          colHist[x * 128 + d]++;
        }
      }
    }
  }

  function toSuffix(hist, n) {
    for (var k = 0; k < n; k++) {
      var base = k * 128, acc = 0;
      for (var t = 127; t >= 0; t--) {
        var v = hist[base + t];
        hist[base + t] = acc; // d > t 인 개수
        acc += v;
      }
    }
  }

  // source: ImageBitmap 등 drawImage 가능한 것. makeCanvas(w,h) → 2d 캔버스.
  // 큰 이미지도 메모리를 아끼도록 가로 띠(strip) 단위로 픽셀을 읽는다.
  async function buildHistograms(source, w, h, makeCanvas, yieldFn) {
    var stripH = Math.max(1, Math.min(h, Math.floor(4000000 / w)));
    var canvas = makeCanvas(w, stripH);
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2d 컨텍스트를 만들 수 없음');
    var rowHist = new Uint32Array(h * 128);
    var colHist = new Uint32Array(w * 128);
    var dmap = new Uint8Array(w * h); // 픽셀별 흰색과의 차이 (가장자리 다듬기용)
    for (var y = 0; y < h; y += stripH) {
      var rows = Math.min(stripH, h - y);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#fff'; // 투명 영역은 흰 배경으로 합성
      ctx.fillRect(0, 0, w, stripH);
      ctx.drawImage(source, 0, -y);
      var data = ctx.getImageData(0, 0, w, rows).data;
      accumulateStrip(data, w, rows, y, rowHist, colHist, dmap);
      if (yieldFn) await yieldFn();
    }
    toSuffix(rowHist, h);
    toSuffix(colHist, w);
    return { w: w, h: h, rowCum: rowHist, colCum: colHist, dmap: dmap };
  }

  // 워커 안에서 도는 코드. 작업 두 가지:
  //  analyze — 이미지의 가로 띠 하나를 분석해 행 · 열 누적 히스토그램과 차이 맵을 돌려준다.
  //  render  — 최종 결과를 그리고 JPEG/PNG로 인코딩해 Blob을 돌려준다.
  function workerMain() {
    self.onmessage = async function (e) {
      var msg = e.data, bmp = msg.bitmap;
      try {
        if (typeof OffscreenCanvas === 'undefined') throw new Error('no-offscreen');
        if (msg.type === 'analyze') {
          var res = await buildHistograms(bmp, bmp.width, bmp.height,
            function (w, h) { return new OffscreenCanvas(w, h); }, null);
          bmp.close();
          self.postMessage({ id: msg.id, ok: true, rowCum: res.rowCum, colCum: res.colCum, dmap: res.dmap },
            [res.rowCum.buffer, res.colCum.buffer, res.dmap.buffer]);
        } else if (msg.type === 'deskew') {
          var ns = deskewSize(bmp.width, bmp.height, msg.angle);
          var dc = new OffscreenCanvas(ns.w, ns.h), dctx = dc.getContext('2d');
          if (!dctx || typeof dc.transferToImageBitmap !== 'function') throw new Error('no-offscreen');
          drawDeskewed(dctx, bmp, bmp.width, bmp.height, ns.w, ns.h, msg.angle);
          bmp.close();
          var out = dc.transferToImageBitmap();
          self.postMessage({ id: msg.id, ok: true, bitmap: out }, [out]);
        } else {
          var r = msg.rect, c = new OffscreenCanvas(r.w, r.h), ctx = c.getContext('2d');
          if (!ctx || typeof c.convertToBlob !== 'function') throw new Error('no-offscreen');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, r.w, r.h);
          ctx.imageSmoothingEnabled = false;
          ctx.translate(-r.x, -r.y);
          applyRotation(ctx, msg.srcW, msg.srcH, msg.rot);
          ctx.drawImage(bmp, msg.sx, msg.sy); // 필요한 부분만 잘라 받은 원본을 제자리에
          bmp.close();
          var blob = await c.convertToBlob(msg.format === 'png' ? { type: 'image/png' } : { type: 'image/jpeg', quality: msg.quality });
          self.postMessage({ id: msg.id, ok: true, blob: blob });
        }
      } catch (err) {
        try { bmp.close(); } catch (_) { /* 무시 */ }
        self.postMessage({ id: msg.id, ok: false, error: String((err && err.message) || err) });
      }
    };
  }

  /* 워커 풀: CPU 코어 수만큼(최대 8) 띄워 여러 이미지 · 한 이미지의 여러 띠를 동시에 처리한다.
   * 별도 파일 없이 Blob URL로 만들고, 만들 수 없으면 메인 스레드에서 쉬어 가며 처리한다. */
  var POOL_SIZE = Math.max(2, Math.min(8, ((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4) - 1));
  var pool = [], poolBroken = false, poolUrl = null, jobQueue = [], jobSeq = 0;

  function ensurePool() {
    if (pool.length || poolBroken) return;
    try {
      if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function') throw new Error('unsupported');
      if (!poolUrl) {
        var src = [accumulateStrip, toSuffix, buildHistograms, applyRotation, deskewSize, drawDeskewed, workerMain]
          .map(function (f) { return f.toString(); }).join('\n') + '\nworkerMain();';
        poolUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      }
      for (var i = 0; i < POOL_SIZE; i++) pool.push(spawnWorker());
    } catch (_) {
      pool.forEach(function (w) { w.terminate(); });
      pool = []; poolBroken = true;
    }
  }

  function spawnWorker() {
    var w = new Worker(poolUrl);
    w.job = null;
    w.onmessage = function (e) {
      var job = w.job;
      w.job = null;
      if (job && job.id === e.data.id) {
        if (e.data.ok) job.resolve(e.data);
        else {
          if (e.data.error === 'no-offscreen') breakPool();
          job.reject(new Error(e.data.error));
        }
      }
      pump();
    };
    w.onerror = function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      var job = w.job;
      w.job = null;
      w.terminate();
      pool = pool.filter(function (x) { return x !== w; });
      if (!pool.length) breakPool();
      if (job) job.reject(new Error('worker-failed'));
      pump();
    };
    return w;
  }

  function breakPool() {
    poolBroken = true;
    var q = jobQueue; jobQueue = [];
    q.forEach(function (job) { job.reject(new Error('worker-failed')); });
  }

  function pump() {
    for (var i = 0; i < pool.length && jobQueue.length; i++) {
      var w = pool[i];
      if (w.job) continue;
      var job = jobQueue.shift();
      job.id = job.msg.id = ++jobSeq;
      w.job = job;
      w.postMessage(job.msg, job.transfer);
    }
  }

  function runJob(msg, transfer) {
    return new Promise(function (resolve, reject) {
      ensurePool();
      if (poolBroken) { reject(new Error('worker-failed')); return; }
      jobQueue.push({ msg: msg, transfer: transfer, resolve: resolve, reject: reject });
      pump();
    });
  }

  function workersAvailable() { ensurePool(); return !poolBroken; }
  function isBitmap(b) { return typeof ImageBitmap !== 'undefined' && b instanceof ImageBitmap; }

  function nextFrame() { return new Promise(function (r) { setTimeout(r, 0); }); }

  // 메인 스레드 대체 경로: 한 번에 한 장씩(메모리 · 반응성 보호)
  var mainQueue = Promise.resolve();
  function analyzeOnMain(bitmap) {
    var run = function () {
      var w = bitmap.width || bitmap.naturalWidth, h = bitmap.height || bitmap.naturalHeight;
      return buildHistograms(bitmap, w, h, function (cw, ch) {
        var c = document.createElement('canvas'); c.width = cw; c.height = ch; return c;
      }, nextFrame);
    };
    var p = mainQueue.then(run, run);
    mainQueue = p.catch(function () { /* 다음 작업은 계속 */ });
    return p;
  }

  // 큰 이미지는 가로 띠(약 150만 픽셀 이상씩, 최대 워커 수만큼)로 나눠 동시에 분석하고 합친다.
  // 행 히스토그램은 띠마다 따로, 열 히스토그램은 띠별 결과의 합(누적합도 선형이라 그대로 더하면 됨).
  function analyzeBitmap(bitmap, opts) {
    if ((opts && opts.forceMain) || !isBitmap(bitmap) || !workersAvailable()) return analyzeOnMain(bitmap);
    var W = bitmap.width, H = bitmap.height;
    var bands = Math.max(1, Math.min(POOL_SIZE, Math.floor(W * H / 1500000), H));
    if (opts && opts.bands) bands = Math.max(1, Math.min(opts.bands, H));
    var bandH = Math.ceil(H / bands), parts = [];
    for (var y = 0; y < H; y += bandH) parts.push(analyzeBand(bitmap, y, Math.min(bandH, H - y)));
    return Promise.all(parts).then(function (res) { return mergeBands(res, W, H); })
      .catch(function () { return analyzeOnMain(bitmap); });
  }

  function analyzeBand(bitmap, y, h) {
    var src = (y === 0 && h === bitmap.height) ? createImageBitmap(bitmap) : createImageBitmap(bitmap, 0, y, bitmap.width, h);
    return src.then(function (band) {
      return runJob({ type: 'analyze', bitmap: band }, [band]);
    }).then(function (r) { r.y = y; r.h = h; return r; });
  }

  function mergeBands(parts, W, H) {
    if (parts.length === 1) return { w: W, h: H, rowCum: parts[0].rowCum, colCum: parts[0].colCum, dmap: parts[0].dmap };
    var rowCum = new Uint32Array(H * NB), colCum = parts[0].colCum, dmap = new Uint8Array(W * H);
    parts.forEach(function (p, i) {
      rowCum.set(p.rowCum, p.y * NB);
      dmap.set(p.dmap, p.y * W);
      if (i > 0) { var c = p.colCum; for (var k = 0; k < c.length; k++) colCum[k] += c[k]; }
    });
    return { w: W, h: H, rowCum: rowCum, colCum: colCum, dmap: dmap };
  }

  // 노이즈 필터 단계(0~10) → 행/열 하나에 있어야 하는 최소 내용 픽셀 수.
  // 단계 n = 그 행/열 길이의 n‰(0.1% 단위). 0이면 1픽셀만 있어도 내용으로 본다.
  function noiseMinCount(length, level) {
    if (!(level > 0)) return 1;
    return Math.max(1, Math.ceil(length * level / 1000));
  }

  // 원본 좌표계에서 내용 영역 {x0,y0,x1,y1}(양 끝 포함) 또는 null(내용 없음)
  function computeContentBox(a, threshold, noiseLevel) {
    var t = Math.max(0, Math.min(126, Math.round(threshold)));
    var minRow = noiseMinCount(a.w, noiseLevel);
    var minCol = noiseMinCount(a.h, noiseLevel);
    var y0 = -1, y1 = -1, x0 = -1, x1 = -1, i;
    for (i = 0; i < a.h; i++) if (a.rowCum[i * NB + t] >= minRow) { y0 = i; break; }
    if (y0 < 0) return null;
    for (i = a.h - 1; i >= y0; i--) if (a.rowCum[i * NB + t] >= minRow) { y1 = i; break; }
    for (i = 0; i < a.w; i++) if (a.colCum[i * NB + t] >= minCol) { x0 = i; break; }
    if (x0 < 0) return null;
    for (i = a.w - 1; i >= x0; i--) if (a.colCum[i * NB + t] >= minCol) { x1 = i; break; }
    return { x0: x0, y0: y0, x1: x1, y1: y1 };
  }

  /* 가장자리 다듬기 (사진처럼 꽉 찬 내용용)
   * 행/열 경계 상자만으로는 두 가지 흰 틈이 남는다.
   *  ① 사진이 살짝 기울어 생기는 모서리의 흰 쐐기
   *  ② 사진과 종이가 섞인 경계선 1~2px (옅게 보이는 선)
   * 그래서 상자의 각 변을 한 줄씩 안쪽으로 옮기며, 그 줄이 아래 중 하나면 잘라 낸다.
   *  - 종이색 픽셀이 1% 넘게 있음
   *  - 줄의 맨 끝 픽셀이 종이색이거나, 양 끝에서 이어지는 밝은(임계값 이하) 픽셀이 1% 이상(쐐기)
   *  - 평균 진하기가 3줄 안쪽의 60% 미만(옅은 경계선)
   * 종이색 기준은 상자 바깥 여백의 밝기(상위 1%)에서 잡는다.
   * 상자 가운데에 종이색이 5% 넘게 보이면 문서 · 그림처럼 성긴 내용이므로 건너뛴다.
   * 한 변에서 최대 6%까지만 깎는다(약 2°까지의 기울기에 해당).
   */
  function refineBox(a, box, threshold) {
    var W = a.w, H = a.h, dm = a.dmap;
    if (!dm || !box) return { box: box, applied: false };
    var T = Math.max(1, Math.min(126, Math.round(threshold)));
    var x0 = box.x0, y0 = box.y0, x1 = box.x1, y1 = box.y1;
    if (x1 - x0 < 16 || y1 - y0 < 16) return { box: box, applied: false };

    // 1) 종이색 수준: 상자 바깥 행 · 열의 d 분포에서 상위 1% 지점
    var over = new Float64Array(128), tot = 0, t, y, x;
    for (y = 0; y < H; y++) {
      if (y >= y0 && y <= y1) continue;
      tot += W;
      for (t = 0; t < 128; t++) over[t] += a.rowCum[y * 128 + t];
    }
    for (x = 0; x < W; x++) {
      if (x >= x0 && x <= x1) continue;
      tot += H;
      for (t = 0; t < 128; t++) over[t] += a.colCum[x * 128 + t];
    }
    var lvl = 4;
    if (tot >= 100) { for (t = 4; t < 127; t++) { if (over[t] <= tot * 0.01) break; } lvl = t; }
    var paperT = Math.max(4, Math.min(T - 1, lvl + 4));

    // 2) 꽉 찬 내용인지: 상자 가운데(가장자리 10% 제외)의 종이색 비율
    var bw = x1 - x0 + 1, bh = y1 - y0 + 1, n = 0, paper = 0;
    for (y = y0 + Math.floor(bh / 10); y <= y1 - Math.floor(bh / 10); y += 2) {
      var row = y * W;
      for (x = x0 + Math.floor(bw / 10); x <= x1 - Math.floor(bw / 10); x += 2) {
        n++;
        if (dm[row + x] <= paperT) paper++;
      }
    }
    if (!n || paper / n > 0.05) return { box: box, applied: false, paperT: paperT };

    // 3) 변 깎기: 매번 네 변의 '흰 틈 점수'를 매겨 가장 나쁜 변만 한 줄 깎는다.
    //    (한 변을 깎으면 옆 변 끝의 흰 픽셀도 함께 사라지므로, 동시에 깎으면 과하게 잘린다)
    function score(start, step, len, inner) {
      var p = 0, sum = 0, isum = 0, i, k = start, j = inner;
      for (i = 0; i < len; i++, k += step, j += step) {
        var v = dm[k];
        if (v <= paperT) p++;
        sum += v; isum += dm[j];
      }
      var rs = 0, re = 0;
      for (i = 0, k = start; i < len && dm[k] <= T; i++, k += step) rs++;
      for (i = 0, k = start + (len - 1) * step; i < len && dm[k] <= T; i++, k -= step) re++;
      var pale = sum < 0.6 * isum;
      var bad = p > Math.max(1, len * 0.01) ||
        dm[start] <= paperT || dm[start + (len - 1) * step] <= paperT || // 줄 끝이 종이색(쐐기 끝)
        rs + re >= Math.max(3, len * 0.01) ||
        pale;
      if (!bad) return 0;
      return (p + rs + re) / len + (pale ? 1 - sum / Math.max(1, isum) : 0) + 1e-9;
    }
    var capX = Math.max(2, Math.ceil(bw * 0.06)), capY = Math.max(2, Math.ceil(bh * 0.06));
    for (var guard = 0; guard < 4 * (capX + capY) && x1 - x0 >= 8 && y1 - y0 >= 8; guard++) {
      var lw = x1 - x0 + 1, lh = y1 - y0 + 1;
      var sT = y0 - box.y0 < capY ? score(y0 * W + x0, 1, lw, (y0 + 3) * W + x0) : 0;
      var sB = box.y1 - y1 < capY ? score(y1 * W + x0, 1, lw, (y1 - 3) * W + x0) : 0;
      var sL = x0 - box.x0 < capX ? score(y0 * W + x0, W, lh, y0 * W + x0 + 3) : 0;
      var sR = box.x1 - x1 < capX ? score(y0 * W + x1, W, lh, y0 * W + x1 - 3) : 0;
      var best = Math.max(sT, sB, sL, sR);
      if (best <= 0) break;
      if (best === sT) y0++;
      else if (best === sB) y1--;
      else if (best === sL) x0++;
      else x1--;
    }
    return { box: { x0: x0, y0: y0, x1: x1, y1: y1 }, applied: true, paperT: paperT };
  }

  /* 자동 기울기 측정
   * 내용 상자의 네 변마다, 가운데 70% 구간에서 "처음 만나는 내용 픽셀(3px 연속)" 위치를
   * 줄마다 모아 직선을 맞춘다(Theil–Sen: 기울기 쌍의 중앙값이라 튀는 점에 강함).
   * 점의 80% 이상이 직선에서 2px 안에 있으면 '곧은 변'으로 보고, 곧은 변들의 각도가
   * 서로 맞으면 그 값을 기울기로 쓴다. 사진처럼 테두리가 곧은 내용만 보정되고,
   * 들쭉날쭉한 문서 · 그림은 대개 0(보정 안 함)이 된다.
   * 반환값: 시계 방향 기울기(도). 보정은 반대로 돌린다.
   */
  function estimateSkew(a, threshold, noiseLevel) {
    var none = { angle: 0, edges: 0 };
    var dm = a.dmap, W = a.w;
    if (!dm) return none;
    var box = computeContentBox(a, threshold, noiseLevel);
    if (!box) return none;
    var T = Math.max(1, Math.min(254, Math.round(threshold)));
    var x0 = box.x0, y0 = box.y0, x1 = box.x1, y1 = box.y1;
    var bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (bw < 60 || bh < 60) return none;
    var depthX = Math.ceil(bw * 0.3), depthY = Math.ceil(bh * 0.3);
    function solid(k, step) { return dm[k] > T && dm[k + step] > T && dm[k + 2 * step] > T; }
    function samples(from, to) {
      var n = Math.min(160, to - from + 1), out = [];
      for (var i = 0; i < n; i++) out.push(Math.round(from + (to - from) * (n === 1 ? 0.5 : i / (n - 1))));
      return out;
    }
    var rows = samples(y0 + Math.floor(bh * 0.15), y1 - Math.floor(bh * 0.15));
    var cols = samples(x0 + Math.floor(bw * 0.15), x1 - Math.floor(bw * 0.15));
    var L = [], R = [], Tp = [], B = [], i, j, k;
    for (i = 0; i < rows.length; i++) {
      var y = rows[i], base = y * W;
      for (j = 0; j < depthX; j++) { k = base + x0 + j; if (x0 + j + 2 <= x1 && solid(k, 1)) { L.push(y, x0 + j); break; } }
      for (j = 0; j < depthX; j++) { k = base + x1 - j; if (x1 - j - 2 >= x0 && solid(k, -1)) { R.push(y, x1 - j); break; } }
    }
    for (i = 0; i < cols.length; i++) {
      var x = cols[i];
      for (j = 0; j < depthY; j++) { if (y0 + j + 2 <= y1 && solid((y0 + j) * W + x, W)) { Tp.push(x, y0 + j); break; } }
      for (j = 0; j < depthY; j++) { if (y1 - j - 2 >= y0 && solid((y1 - j) * W + x, -W)) { B.push(x, y1 - j); break; } }
    }
    function fit(pts) { // pts = [u0,v0,u1,v1,...], v ≈ m·u + c
      var n = pts.length / 2;
      if (n < 20) return null;
      var slopes = [];
      for (var p = 0; p < n; p++) {
        for (var q = p + 1; q < n; q++) {
          var du = pts[2 * q] - pts[2 * p];
          if (du) slopes.push((pts[2 * q + 1] - pts[2 * p + 1]) / du);
        }
      }
      if (!slopes.length) return null;
      var m = median(slopes);
      var cs = [];
      for (p = 0; p < n; p++) cs.push(pts[2 * p + 1] - m * pts[2 * p]);
      var c = median(cs), inl = 0;
      for (p = 0; p < n; p++) if (Math.abs(pts[2 * p + 1] - (m * pts[2 * p] + c)) <= 2) inl++;
      return { m: m, frac: inl / n };
    }
    function median(arr) {
      var s = Float64Array.from(arr).sort(), h = s.length >> 1;
      return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
    }
    var DEG = 180 / Math.PI, good = [];
    var fl = fit(L), fr = fit(R), ft = fit(Tp), fb = fit(B);
    // 세로 변: x = m·y + c → 시계 방향 θ이면 m = −tanθ / 가로 변: y = m·x + c → m = tanθ
    if (fl && fl.frac >= 0.8) good.push({ a: -Math.atan(fl.m) * DEG, f: fl.frac });
    if (fr && fr.frac >= 0.8) good.push({ a: -Math.atan(fr.m) * DEG, f: fr.frac });
    if (ft && ft.frac >= 0.8) good.push({ a: Math.atan(ft.m) * DEG, f: ft.frac });
    if (fb && fb.frac >= 0.8) good.push({ a: Math.atan(fb.m) * DEG, f: fb.frac });
    if (!good.length) return none;
    var mid = median(good.map(function (g) { return g.a; }));
    var agree = good.filter(function (g) { return Math.abs(g.a - mid) <= 0.3; });
    if (agree.length < 2 && !(agree.length === 1 && agree[0].f >= 0.9 && good.length === 1)) return none;
    var sum = 0, wsum = 0;
    agree.forEach(function (g) { sum += g.a * g.f; wsum += g.f; });
    var angle = sum / wsum;
    if (!(Math.abs(angle) <= 15)) return none;
    return { angle: angle, edges: agree.length };
  }

  // 기울기 보정 후 캔버스 크기와 그리기(워커와 메인 스레드가 함께 쓴다 — 바깥 변수 참조 금지)
  function deskewSize(w, h, deg) {
    var r = deg * Math.PI / 180, c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
    return { w: Math.ceil(w * c + h * s), h: Math.ceil(w * s + h * c) };
  }
  function drawDeskewed(ctx, src, w, h, nw, nh, deg) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, nw, nh);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(nw / 2, nh / 2);
    ctx.rotate(-deg * Math.PI / 180); // 시계 방향으로 기운 만큼 반대로
    ctx.drawImage(src, -w / 2, -h / 2);
  }

  function rotatedSize(w, h, rot) {
    return (rot === 90 || rot === 270) ? { w: h, h: w } : { w: w, h: h };
  }

  // 원본 좌표의 상자를 시계 방향 rot° 회전한 이미지 좌표로 옮긴다.
  function rotateBox(b, w, h, rot) {
    switch (rot) {
      case 90: return { x0: h - 1 - b.y1, x1: h - 1 - b.y0, y0: b.x0, y1: b.x1 };
      case 180: return { x0: w - 1 - b.x1, x1: w - 1 - b.x0, y0: h - 1 - b.y1, y1: h - 1 - b.y0 };
      case 270: return { x0: b.y0, x1: b.y1, y0: w - 1 - b.x1, y1: w - 1 - b.x0 };
      default: return { x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1 };
    }
  }

  // 회전된 이미지 기준 출력 사각형. 여백(padding)이 이미지 밖으로 나가면 흰색으로 채운다.
  function outputRect(rbox, padding) {
    var p = Math.max(0, Math.round(padding) || 0);
    return { x: rbox.x0 - p, y: rbox.y0 - p, w: rbox.x1 - rbox.x0 + 1 + 2 * p, h: rbox.y1 - rbox.y0 + 1 + 2 * p };
  }

  // 원본(w×h)을 rot° 회전해 그리는 변환을 현재 ctx 변환 뒤에 붙인다.
  function applyRotation(ctx, w, h, rot) {
    if (rot === 90) { ctx.translate(h, 0); ctx.rotate(Math.PI / 2); }
    else if (rot === 180) { ctx.translate(w, h); ctx.rotate(Math.PI); }
    else if (rot === 270) { ctx.translate(0, w); ctx.rotate(-Math.PI / 2); }
  }

  // 크롭 계산 전체: 분석 결과 + 옵션 → { box(원본), rbox(회전), rect(출력), rotW, rotH, empty }
  function planCrop(a, opts) {
    var rot = opts.rotation || 0;
    var rs = rotatedSize(a.w, a.h, rot);
    var rawBox = computeContentBox(a, opts.threshold, opts.noise);
    var box = rawBox, refined = false;
    if (rawBox && opts.trim) {
      var rf = refineBox(a, rawBox, opts.threshold);
      box = rf.box; refined = rf.applied;
    }
    var empty = !box;
    var rbox = empty ? { x0: 0, y0: 0, x1: rs.w - 1, y1: rs.h - 1 } : rotateBox(box, a.w, a.h, rot);
    var rect = empty ? { x: 0, y: 0, w: rs.w, h: rs.h } : outputRect(rbox, opts.padding);
    return { rawBox: rawBox, box: box, refined: refined, rbox: rbox, rect: rect, rotW: rs.w, rotH: rs.h, empty: empty };
  }

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  // 원본 해상도로 최종 결과를 그린다.
  function renderOutput(bitmap, rot, rect) {
    var c = makeCanvas(rect.w, rect.h);
    var ctx = c.getContext('2d');
    if (!ctx || c.width !== rect.w || c.height !== rect.h) throw new Error('canvas-too-large');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, rect.w, rect.h);
    ctx.imageSmoothingEnabled = false;
    ctx.translate(-rect.x, -rect.y);
    applyRotation(ctx, bitmap.width, bitmap.height, rot);
    ctx.drawImage(bitmap, 0, 0);
    return c;
  }

  function canvasToBlob(canvas, format, quality) {
    var type = format === 'png' ? 'image/png' : 'image/jpeg';
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) {
        if (b) resolve(b); else reject(new Error('canvas-too-large'));
      }, type, format === 'png' ? undefined : quality);
    });
  }

  // 최종 결과 Blob. 워커 풀에서 그리기 + 인코딩까지 해서 여러 장을 동시에 만든다.
  // 원본 전체가 아니라 결과에 필요한 부분만 잘라 워커로 넘긴다.
  function renderBlob(bitmap, rot, rect, format, quality) {
    var onMain = function () {
      var c = renderOutput(bitmap, rot, rect);
      return canvasToBlob(c, format, quality).then(function (b) { c.width = c.height = 0; return b; });
    };
    if (!isBitmap(bitmap) || !workersAvailable()) return onMain();
    var W = bitmap.width, H = bitmap.height, rs = rotatedSize(W, H, rot);
    var ix0 = Math.max(0, rect.x), iy0 = Math.max(0, rect.y);
    var ix1 = Math.min(rs.w, rect.x + rect.w) - 1, iy1 = Math.min(rs.h, rect.y + rect.h) - 1;
    var src = rotateBox({ x0: ix0, y0: iy0, x1: ix1, y1: iy1 }, rs.w, rs.h, (360 - rot) % 360); // 회전 좌표 → 원본 좌표
    return createImageBitmap(bitmap, src.x0, src.y0, src.x1 - src.x0 + 1, src.y1 - src.y0 + 1).then(function (part) {
      return runJob({ type: 'render', bitmap: part, sx: src.x0, sy: src.y0, srcW: W, srcH: H, rot: rot, rect: rect, format: format, quality: quality }, [part]);
    }).then(function (r) { return r.blob; }, onMain);
  }

  // 원본을 기울기만큼 반대로 돌린 새 ImageBitmap(바깥은 흰색). 워커에서, 안 되면 메인 스레드에서.
  function deskewBitmap(bitmap, deg) {
    var onMain = function () {
      var ns = deskewSize(bitmap.width, bitmap.height, deg);
      var c = makeCanvas(ns.w, ns.h), ctx = c.getContext('2d');
      if (!ctx || c.width !== ns.w) return Promise.reject(new Error('canvas-too-large'));
      drawDeskewed(ctx, bitmap, bitmap.width, bitmap.height, ns.w, ns.h, deg);
      return createImageBitmap(c).then(function (b) { c.width = c.height = 0; return b; });
    };
    if (!isBitmap(bitmap) || !workersAvailable()) return onMain();
    return createImageBitmap(bitmap).then(function (copy) {
      return runJob({ type: 'deskew', bitmap: copy, angle: deg }, [copy]);
    }).then(function (r) { return r.bitmap; }, onMain);
  }

  function outputName(original, format) {
    var base = (original || 'image').replace(/\.[^./\\]+$/, '') || 'image';
    return base + '_crop.' + (format === 'png' ? 'png' : 'jpg');
  }

  var DEFAULTS = { threshold: 40, noise: 5, padding: 0, trim: true, deskew: true, rotation: 0, format: 'jpeg', quality: 92 };
  var DESKEW_MIN = 0.1; // 이보다 작은 기울기(도)는 보간 손실이 더 커서 그대로 둔다

  window.WhiteCrop = {
    DEFAULTS: DEFAULTS,
    analyzeBitmap: analyzeBitmap,
    computeContentBox: computeContentBox,
    refineBox: refineBox,
    estimateSkew: estimateSkew,
    deskewBitmap: deskewBitmap,
    deskewSize: deskewSize,
    DESKEW_MIN: DESKEW_MIN,
    noiseMinCount: noiseMinCount,
    rotatedSize: rotatedSize,
    rotateBox: rotateBox,
    outputRect: outputRect,
    planCrop: planCrop,
    renderOutput: renderOutput,
    renderBlob: renderBlob,
    canvasToBlob: canvasToBlob,
    poolSize: function () { return workersAvailable() ? pool.length : 0; },
    outputName: outputName,
    usingWorker: function () { return workersAvailable(); }
  };

  /* ───────────────────────── UI ───────────────────────── */
  if (!document.getElementById('dropzone')) return;

  var PREVIEW_MAX = 1000; // 미리보기 캔버스 최대 변 길이(px)
  var $ = function (sel, root) { return (root || document).querySelector(sel); };

  var opts = Object.assign({}, DEFAULTS);
  var items = [];
  var itemSeq = 0;

  var el = {
    dropzone: $('#dropzone'),
    file: $('#file-input'),
    list: $('#list'),
    toolbar: $('#toolbar'),
    count: $('#count'),
    zip: $('#zip-btn'),
    clear: $('#clear-btn'),
    status: $('#status'),
    threshold: $('#opt-threshold'),
    thresholdOut: $('#out-threshold'),
    noise: $('#opt-noise'),
    noiseOut: $('#out-noise'),
    padding: $('#opt-padding'),
    trim: $('#opt-trim'),
    deskew: $('#opt-deskew'),
    quality: $('#opt-quality'),
    qualityOut: $('#out-quality'),
    qualityRow: $('#quality-row'),
    reset: $('#reset-btn'),
    tpl: $('#card-tpl')
  };

  function setStatus(text) { el.status.textContent = text || ''; }

  /* 옵션 */
  function syncOptionUI() {
    el.threshold.value = opts.threshold;
    el.thresholdOut.textContent = opts.threshold;
    el.noise.value = opts.noise;
    el.noiseOut.textContent = opts.noise === 0 ? '끔' : opts.noise + ' (' + (opts.noise / 10).toFixed(1) + '%)';
    el.padding.value = opts.padding;
    el.trim.checked = !!opts.trim;
    el.deskew.checked = !!opts.deskew;
    el.quality.value = opts.quality;
    el.qualityOut.textContent = opts.quality;
    el.qualityRow.hidden = opts.format !== 'jpeg';
    document.querySelectorAll('[data-rot]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.rot) === opts.rotation));
    });
    document.querySelectorAll('[data-format]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.format === opts.format));
    });
  }

  var redrawQueued = false;
  function scheduleRedrawAll() {
    if (redrawQueued) return;
    redrawQueued = true;
    requestAnimationFrame(function () {
      redrawQueued = false;
      items.forEach(updateItem);
    });
  }

  el.threshold.addEventListener('input', function () {
    opts.threshold = Number(el.threshold.value); syncOptionUI(); scheduleRedrawAll(); scheduleDeskew();
  });
  el.noise.addEventListener('input', function () {
    opts.noise = Number(el.noise.value); syncOptionUI(); scheduleRedrawAll(); scheduleDeskew();
  });
  el.padding.addEventListener('input', function () {
    var v = Math.floor(Number(el.padding.value));
    opts.padding = isFinite(v) && v > 0 ? Math.min(v, 2000) : 0;
    scheduleRedrawAll();
  });
  el.padding.addEventListener('change', syncOptionUI);
  el.trim.addEventListener('change', function () {
    opts.trim = el.trim.checked; scheduleRedrawAll();
  });
  el.deskew.addEventListener('change', function () {
    opts.deskew = el.deskew.checked; scheduleDeskew(0);
  });
  el.quality.addEventListener('input', function () {
    opts.quality = Number(el.quality.value); syncOptionUI();
  });
  document.querySelectorAll('[data-rot]').forEach(function (b) {
    b.addEventListener('click', function () {
      opts.rotation = Number(b.dataset.rot);
      items.forEach(function (it) { setItemRotation(it, opts.rotation); });
      syncOptionUI();
    });
  });
  document.querySelectorAll('[data-format]').forEach(function (b) {
    b.addEventListener('click', function () {
      opts.format = b.dataset.format; syncOptionUI(); scheduleRedrawAll();
    });
  });
  el.reset.addEventListener('click', function () {
    var rot = opts.rotation;
    opts = Object.assign({}, DEFAULTS, { rotation: rot });
    syncOptionUI(); scheduleRedrawAll(); scheduleDeskew(0);
  });

  /* 파일 받기: 선택 · 드래그앤드롭 · 붙여넣기 */
  el.dropzone.addEventListener('click', function () { el.file.click(); });
  el.dropzone.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.file.click(); }
  });
  el.file.addEventListener('change', function () {
    addFiles(Array.from(el.file.files || []));
    el.file.value = '';
  });

  var dragDepth = 0;
  window.addEventListener('dragenter', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth++; el.dropzone.classList.add('is-over');
  });
  window.addEventListener('dragover', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', function (e) {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) el.dropzone.classList.remove('is-over');
  });
  window.addEventListener('drop', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; el.dropzone.classList.remove('is-over');
    addFiles(Array.from(e.dataTransfer.files || []));
  });
  function hasFiles(e) {
    return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0;
  }

  document.addEventListener('paste', function (e) {
    var cd = e.clipboardData;
    if (!cd) return;
    var files = [];
    Array.from(cd.items || []).forEach(function (it) {
      if (it.kind === 'file' && /^image\//.test(it.type)) {
        var f = it.getAsFile();
        if (f) files.push(f);
      }
    });
    if (!files.length) return;
    e.preventDefault();
    var stamp = timestamp();
    addFiles(files.map(function (f, i) {
      var ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/\+.*$/, '');
      var name = '붙여넣기_' + stamp + (files.length > 1 ? '_' + (i + 1) : '') + '.' + ext;
      try { return new File([f], name, { type: f.type }); } catch (_) { f.displayName = name; return f; }
    }));
  });

  function timestamp() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function addFiles(files) {
    var images = files.filter(function (f) { return /^image\//.test(f.type) || /\.(jpe?g|png|gif|webp|bmp|avif)$/i.test(f.name); });
    var skipped = files.length - images.length;
    images.forEach(function (f) { addItem(f); });
    if (skipped) setStatus('이미지가 아닌 파일 ' + skipped + '개는 건너뛰었습니다.');
  }

  /* 이미지 항목 */
  function addItem(file) {
    var node = el.tpl.content.firstElementChild.cloneNode(true);
    var it = {
      id: ++itemSeq,
      file: file,
      name: file.displayName || file.name || 'image.png',
      rot: opts.rotation,
      bitmap: null,
      analysis: null,
      preview: null,      // 회전 안 한 축소본
      previewRot: null,   // 현재 회전을 적용한 축소본
      previewRotFor: null,
      plan: null,
      base: null,
      state: null,
      skewCache: new Map(),
      skewToken: 0,
      skewBusy: false,
      error: null,
      node: node,
      ui: {
        name: $('.card-name', node),
        orig: $('.cv-orig', node),
        res: $('.cv-res', node),
        origCap: $('.cap-orig', node),
        resCap: $('.cap-res', node),
        msg: $('.card-msg', node),
        rotLabel: $('.rot-label', node),
        download: $('.dl-btn', node)
      }
    };
    it.ui.name.textContent = it.name;
    it.ui.name.title = it.name;
    node.classList.add('is-loading');
    $('.rm-btn', node).addEventListener('click', function () { removeItem(it); });
    $('.rot-left', node).addEventListener('click', function () { setItemRotation(it, (it.rot + 270) % 360); });
    $('.rot-right', node).addEventListener('click', function () { setItemRotation(it, (it.rot + 90) % 360); });
    it.ui.download.addEventListener('click', function () { downloadOne(it); });
    it.ui.rotLabel.textContent = it.rot + '°';
    items.push(it);
    el.list.appendChild(node);
    refreshToolbar();
    loadItem(it);
  }

  function decode(file) {
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(file).catch(function () { return decodeViaImg(file); });
    }
    return decodeViaImg(file);
  }
  function decodeViaImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        // ImageBitmap이 없으면 HTMLImageElement 자체를 소스로 쓴다.
        if (typeof createImageBitmap === 'function') createImageBitmap(img).then(resolve, function () { resolve(img); });
        else resolve(img);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }

  // 미리보기용 축소본(긴 변 PREVIEW_MAX). 가능하면 브라우저 내부 스레드에서 비동기로 줄인다.
  function makePreview(bmp) {
    var w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
    var s = Math.min(1, PREVIEW_MAX / Math.max(w, h));
    var pw = Math.max(1, Math.round(w * s)), ph = Math.max(1, Math.round(h * s));
    var small = (isBitmap(bmp) && s < 1)
      ? createImageBitmap(bmp, { resizeWidth: pw, resizeHeight: ph, resizeQuality: 'high' }).catch(function () { return null; })
      : Promise.resolve(null);
    return small.then(function (sm) {
      var pc = makeCanvas(pw, ph), pctx = pc.getContext('2d');
      pctx.fillStyle = '#fff'; pctx.fillRect(0, 0, pw, ph);
      pctx.imageSmoothingQuality = 'high';
      pctx.drawImage(sm || bmp, 0, 0, pw, ph);
      closeBitmap(sm);
      return { canvas: pc, scale: s };
    });
  }

  // 화면 · 출력에 쓰는 '현재 상태'(원본 또는 기울기 보정본)를 바꾼다.
  function applyState(it, st) {
    it.state = st;
    it.bitmap = st.bitmap; it.w = st.w; it.h = st.h;
    it.analysis = st.analysis;
    it.preview = st.preview; it.previewScale = st.previewScale;
    it.previewRot = null;
    updateItem(it);
  }

  /* 자동 기울기: 원본 분석에서 각도를 재고, 필요하면 보정본을 만들어 다시 분석한다.
   * 각도별 보정본은 최근 2개까지 캐시(임계값을 움직여도 각도가 같으면 다시 만들지 않음). */
  function wantedAngle(it) {
    if (!opts.deskew || !it.base || !it.base.analysis) return 0;
    var sk = estimateSkew(it.base.analysis, opts.threshold, opts.noise);
    return Math.abs(sk.angle) >= DESKEW_MIN ? Math.round(sk.angle * 100) / 100 : 0;
  }

  function syncDeskew(it) {
    if (it.removed || !it.base || !it.base.analysis) return Promise.resolve();
    var want = wantedAngle(it);
    var cur = it.state ? it.state.angle : null;
    if (cur !== null && (cur === want || (cur && want && Math.abs(cur - want) < 0.05))) return Promise.resolve();
    var token = ++it.skewToken;
    if (!want) { it.skewBusy = false; applyState(it, it.base); return Promise.resolve(); }
    var cached = it.skewCache.get(want);
    if (cached) { it.skewBusy = false; applyState(it, cached); return Promise.resolve(); }
    it.skewBusy = true;
    if (it.state) updateItem(it);
    return deskewBitmap(it.base.bitmap, want).then(function (db) {
      if (it.removed || token !== it.skewToken) { closeBitmap(db); return; }
      return Promise.all([analyzeBitmap(db), makePreview(db)]).then(function (res) {
        if (it.removed || token !== it.skewToken) { closeBitmap(db); return; }
        var st = { bitmap: db, w: db.width, h: db.height, analysis: res[0], preview: res[1].canvas, previewScale: res[1].scale, angle: want };
        it.skewCache.set(want, st);
        if (it.skewCache.size > 2) {
          var oldest = it.skewCache.keys().next().value, old = it.skewCache.get(oldest);
          it.skewCache.delete(oldest);
          if (old !== it.state) closeBitmap(old.bitmap);
        }
        it.skewBusy = false;
        applyState(it, st);
      });
    }).catch(function () {
      if (it.removed || token !== it.skewToken) return;
      it.skewBusy = false;
      applyState(it, it.base); // 보정에 실패하면 원본으로
    });
  }

  var skewTimer = 0;
  function scheduleDeskew(delay) {
    clearTimeout(skewTimer);
    skewTimer = setTimeout(function () { items.forEach(syncDeskew); }, delay == null ? 250 : delay);
  }

  function loadItem(it) {
    decode(it.file).then(function (bmp) {
      if (it.removed) { closeBitmap(bmp); return; }
      var w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
      var base = { bitmap: bmp, w: w, h: h, analysis: null, preview: null, previewScale: 1, angle: 0 };
      it.base = base;
      it.bitmap = bmp; it.w = w; it.h = h;
      setItemMsg(it, '여백 분석 중…', 'info');
      // 분석(워커 풀)과 미리보기 축소를 동시에 시작한다.
      var t0 = performance.now();
      var analysis = analyzeBitmap(bmp);
      return makePreview(bmp).then(function (pv) {
        base.preview = pv.canvas; base.previewScale = pv.scale;
        if (it.removed) return analysis;
        it.preview = pv.canvas; it.previewScale = pv.scale;
        updateItem(it); // 분석이 끝나기 전에도 원본은 먼저 보여 준다
        return analysis;
      }).then(function (a) {
        if (it.removed) return;
        base.analysis = a;
        it.analyzeMs = performance.now() - t0;
        return syncDeskew(it).then(function () {
          if (it.removed) return;
          if (!it.state) applyState(it, base);
          it.node.classList.remove('is-loading');
          updateItem(it);
        });
      });
    }).catch(function (err) {
      if (it.removed) return;
      it.error = err;
      it.node.classList.remove('is-loading');
      it.node.classList.add('is-error');
      setItemMsg(it, '이 이미지를 열 수 없습니다. 브라우저가 지원하는 형식(JPEG · PNG · WebP 등)인지 확인해 주세요.', 'warn');
      it.ui.download.disabled = true;
      refreshToolbar();
    });
  }

  function closeBitmap(b) { if (b && typeof b.close === 'function') b.close(); }

  function removeItem(it) {
    it.removed = true;
    if (it.base) closeBitmap(it.base.bitmap);
    it.skewCache.forEach(function (st) { closeBitmap(st.bitmap); });
    it.skewCache.clear();
    it.node.remove();
    items = items.filter(function (x) { return x !== it; });
    refreshToolbar();
  }

  el.clear.addEventListener('click', function () {
    items.slice().forEach(removeItem);
    setStatus('');
  });

  function setItemRotation(it, rot) {
    it.rot = rot;
    it.ui.rotLabel.textContent = rot + '°';
    updateItem(it);
  }

  function setItemMsg(it, text, kind) {
    it.ui.msg.textContent = text || '';
    it.ui.msg.hidden = !text;
    it.ui.msg.className = 'card-msg' + (kind ? ' is-' + kind : '');
  }

  function getPreviewRot(it) {
    if (it.previewRot && it.previewRotFor === it.rot) return it.previewRot;
    var p = it.preview, rs = rotatedSize(p.width, p.height, it.rot);
    var c = makeCanvas(rs.w, rs.h), ctx = c.getContext('2d');
    applyRotation(ctx, p.width, p.height, it.rot);
    ctx.drawImage(p, 0, 0);
    it.previewRot = c; it.previewRotFor = it.rot;
    return c;
  }

  function updateItem(it) {
    if (!it.preview) return;
    var pr = getPreviewRot(it);
    var s = it.previewScale;
    var rs = rotatedSize(it.w, it.h, it.rot);

    // 원본 미리보기
    var oc = it.ui.orig;
    if (oc.width !== pr.width || oc.height !== pr.height) { oc.width = pr.width; oc.height = pr.height; }
    var octx = oc.getContext('2d');
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.drawImage(pr, 0, 0);
    var od = rotatedSize(it.base ? it.base.w : it.w, it.base ? it.base.h : it.h, it.rot);
    it.ui.origCap.textContent = '원본 · ' + od.w + '×' + od.h;

    if (!it.analysis) {
      it.ui.res.width = 1; it.ui.res.height = 1;
      it.ui.resCap.textContent = '결과';
      it.ui.download.disabled = true;
      return;
    }

    var plan = planCrop(it.analysis, { threshold: opts.threshold, noise: opts.noise, padding: opts.padding, trim: opts.trim, rotation: it.rot });
    it.plan = plan;

    // 크롭 영역 시각화: 바깥은 어둡게, 경계는 점선
    if (!plan.empty) {
      var bx = plan.rbox.x0 * s, by = plan.rbox.y0 * s;
      var bw = (plan.rbox.x1 - plan.rbox.x0 + 1) * s, bh = (plan.rbox.y1 - plan.rbox.y0 + 1) * s;
      var rx = plan.rect.x * s, ry = plan.rect.y * s, rw = plan.rect.w * s, rh = plan.rect.h * s;
      octx.save();
      octx.fillStyle = 'rgba(0,0,0,0.28)';
      octx.beginPath();
      octx.rect(0, 0, oc.width, oc.height);
      octx.rect(rx, ry, rw, rh);
      octx.fill('evenodd');
      octx.restore();
      var lw = Math.max(1.5, oc.width / 400);
      octx.lineWidth = lw;
      octx.setLineDash([lw * 4, lw * 3]);
      octx.strokeStyle = '#fff';
      octx.lineDashOffset = 0;
      octx.strokeRect(rx + lw / 2, ry + lw / 2, rw - lw, rh - lw);
      octx.strokeStyle = '#e5484d';
      octx.lineDashOffset = lw * 3.5;
      octx.strokeRect(rx + lw / 2, ry + lw / 2, rw - lw, rh - lw);
      if (opts.padding > 0) { // 내용 경계(여백 안쪽)를 가는 선으로
        octx.setLineDash([]);
        octx.lineWidth = 1;
        octx.strokeStyle = 'rgba(229,72,77,0.55)';
        octx.strokeRect(bx + 0.5, by + 0.5, Math.max(0, bw - 1), Math.max(0, bh - 1));
      }
      octx.setLineDash([]);
    }

    // 결과 미리보기
    var r = plan.rect;
    var d = Math.min(1, PREVIEW_MAX / Math.max(r.w, r.h));
    var cw = Math.max(1, Math.round(r.w * d)), ch = Math.max(1, Math.round(r.h * d));
    var rc = it.ui.res;
    if (rc.width !== cw || rc.height !== ch) { rc.width = cw; rc.height = ch; }
    var rctx = rc.getContext('2d');
    rctx.setTransform(1, 0, 0, 1, 0, 0);
    rctx.fillStyle = '#fff';
    rctx.fillRect(0, 0, cw, ch);
    // 이미지 범위와 출력 사각형의 교집합만 그린다(여백이 바깥으로 나간 부분은 흰색)
    var ix0 = Math.max(0, r.x), iy0 = Math.max(0, r.y);
    var ix1 = Math.min(rs.w, r.x + r.w), iy1 = Math.min(rs.h, r.y + r.h);
    if (ix1 > ix0 && iy1 > iy0) {
      rctx.imageSmoothingQuality = 'high';
      rctx.drawImage(pr, ix0 * s, iy0 * s, (ix1 - ix0) * s, (iy1 - iy0) * s,
        (ix0 - r.x) * d, (iy0 - r.y) * d, (ix1 - ix0) * d, (iy1 - iy0) * d);
    }
    it.ui.resCap.textContent = '결과 · ' + r.w + '×' + r.h;

    var angle = it.state ? it.state.angle : 0;
    if (plan.empty) {
      setItemMsg(it, '내용을 찾지 못해 원본을 그대로 둡니다. 임계값을 낮춰 보세요.', 'warn');
    } else {
      var notes = [];
      if (it.skewBusy) notes.push('기울기 보정 중…');
      else if (angle) notes.push('기울기 ' + (angle > 0 ? '+' : '') + angle.toFixed(2) + '° 자동 보정');
      if (r.x === 0 && r.y === 0 && r.w === rs.w && r.h === rs.h) notes.push('잘라낼 흰 여백이 없습니다.');
      setItemMsg(it, notes.join(' · '), notes.length ? 'info' : null);
    }
    it.ui.download.disabled = false;
    refreshToolbar();
  }

  /* 내보내기 */
  function makeBlob(it) {
    return renderBlob(it.bitmap, it.rot, it.plan.rect, opts.format, opts.quality / 100);
  }

  function saveBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  }

  function errText(err) {
    return err && err.message === 'canvas-too-large'
      ? '이미지가 너무 커서 이 기기의 브라우저에서 결과를 만들 수 없습니다.'
      : '결과를 만들지 못했습니다: ' + ((err && err.message) || err);
  }

  function downloadOne(it) {
    if (!it.plan) return;
    var btn = it.ui.download;
    btn.disabled = true;
    var label = btn.textContent;
    btn.textContent = '만드는 중…';
    makeBlob(it).then(function (blob) {
      saveBlob(blob, outputName(it.name, opts.format));
    }).catch(function (err) {
      setItemMsg(it, errText(err), 'warn');
    }).then(function () {
      btn.disabled = false; btn.textContent = label;
    });
  }

  function uniqueName(name, used) {
    if (!used.has(name)) { used.add(name); return name; }
    var dot = name.lastIndexOf('.'), base = name.slice(0, dot), ext = name.slice(dot);
    for (var n = 2; ; n++) {
      var cand = base + ' (' + n + ')' + ext;
      if (!used.has(cand)) { used.add(cand); return cand; }
    }
  }

  el.zip.addEventListener('click', async function () {
    var ready = items.filter(function (it) { return it.plan && !it.error; });
    if (!ready.length) return;
    if (typeof JSZip === 'undefined') { setStatus('ZIP 라이브러리를 불러오지 못했습니다.'); return; }
    el.zip.disabled = true;
    var zip = new JSZip(), used = new Set(), failed = 0, done = 0;
    var format = opts.format;
    setStatus('ZIP 만드는 중… 0 / ' + ready.length);
    // 모든 이미지를 한꺼번에 요청하면 워커 풀이 코어 수만큼 동시에 그리고 인코딩한다.
    var blobs = await Promise.all(ready.map(function (it) {
      return makeBlob(it).then(function (b) { return b; }, function (err) {
        failed++;
        setItemMsg(it, errText(err), 'warn');
        return null;
      }).then(function (b) {
        done++;
        setStatus('ZIP 만드는 중… ' + done + ' / ' + ready.length);
        return b;
      });
    }));
    blobs.forEach(function (b, i) {
      if (b) zip.file(uniqueName(outputName(ready[i].name, format), used), b);
    });
    try {
      var out = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      saveBlob(out, 'crop_' + timestamp() + '.zip');
      setStatus('ZIP 저장 완료 (' + (ready.length - failed) + '장' + (failed ? ', 실패 ' + failed + '장' : '') + ')');
    } catch (err) {
      setStatus('ZIP을 만들지 못했습니다: ' + ((err && err.message) || err));
    }
    el.zip.disabled = false;
  });

  function refreshToolbar() {
    var n = items.length;
    el.toolbar.hidden = n === 0;
    el.count.textContent = n + '장';
    el.zip.disabled = !items.some(function (it) { return it.plan && !it.error; });
  }

  syncOptionUI();
  refreshToolbar();
})();
