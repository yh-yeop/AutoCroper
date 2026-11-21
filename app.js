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

  // 원본이름_crop.확장자 (한 파일에서 여러 장으로 분리한 경우 원본이름_crop_번호.확장자)
  function outputName(original, format, index) {
    var base = (original || 'image').replace(/\.[^./\\]+$/, '') || 'image';
    return base + '_crop' + (index ? '_' + index : '') + '.' + (format === 'png' ? 'png' : 'jpg');
  }

  var DEFAULTS = { threshold: 40, noise: 5, padding: 0, trim: true, deskew: true, split: true, autoSave: false, rotation: 0, format: 'jpeg', quality: 92 };
  var DESKEW_MIN = 0.1; // 이보다 작은 기울기(도)는 보간 손실이 더 커서 그대로 둔다

  /* ───────── 여러 장 분리 (한 번에 여러 사진을 스캔한 파일) ───────── */
  /* ───────────── 여러 장 사진 나누기 (스캔 한 장에 사진 여러 장) ─────────────
   * 흰 종이 위에 놓인 사진 2~6장을 각각의 영역으로 나눈다.
   *  1) 거친 격자(칸 = 최소 틈의 약 1/5, 2px 이상)로 줄이고, 칸 안 픽셀의 절반 이상이
   *     '종이보다 확실히 진한'(d > tL) 칸을 꽉 찬 칸으로 본다. tL = 종이 밝기(밝은 픽셀의
   *     중앙값) + 10 이라, 흐린 하늘 · 흰 옷처럼 거의 흰 부분도 사진으로 잡힌다.
   *  2) 3×3 닫기(팽창→침식)로 사진 속 가는 흰 선을 메운다. 칸이 최소 틈의 1/5 이라
   *     사진 사이 틈(3~4칸 이상)은 메워지지 않는다.
   *  3) 4-연결 성분으로 나누고, 한 성분에 완전히 둘러싸인 빈 칸(구멍)은 그 성분에 넣는다.
   *  4) 흰 띠가 사진 하나를 가로질러 둘로 나눈 경우: 두 조각의 바깥 변 양 끝이 맞고, 마주 보는 변 중
   *     하나라도 들쭉날쭉하거나(진짜 사진 테두리는 곧다) 틈이 최소 틈의 60% 미만(가는 흰 선)이면 다시 합친다.
   *  5) 사진 후보 = 닫기 전 꽉 찬 칸 비율 ≥ 0.7 이고 넓이 ≥ 페이지의 1.5%(두께 ≥ 짧은 변의 5%, 채움 ≥ 0.5),
   *     또는 넓이 0.3% 이상의 반듯한 사각형. 글자 · 선 그림 덩어리(비율 0.55 이하)는 여기서 빠진다.
   *  6) 후보가 2개 이상이고 후보 밖에 남은 진한 픽셀(d > 임계값)이 전체의 10% 이하일 때만
   *     나눈다(문서에 사진이 섞인 페이지 등은 나누지 않음). 결과는 읽는 순서로 정렬.
   * 반환: { regions: [{x0,y0,x1,y1,label,fill}], grid: {cell,gw,gh,labels}, split, reason, stray, lightThreshold }
   *  regions.length ≥ 2(split=true)일 때만 나누면 된다. 1 = 사진 한 장, 0 = 사진 아님/나누지 않음.
   * 외부 변수 · 전역 상태를 쓰지 않는다(이 파일의 split* 보조 함수만 쓴다).
   */
  function findPhotoRegions(a, threshold, opts) {
    opts = opts || {};
    var W = a.w, H = a.h, dm = a.dmap;
    var T = Math.max(1, Math.min(254, Math.round(threshold == null ? 40 : threshold)));
    var minGap = Math.max(8, Math.min(W, H) * 0.01);
    var cell = opts.cell || Math.max(2, Math.round(minGap / 5));
    var gw = Math.ceil(W / cell), gh = Math.ceil(H / cell), N = gw * gh;
    var labels = new Int32Array(N);
    var res = { regions: [], grid: { cell: cell, gw: gw, gh: gh, labels: labels }, split: false, reason: '', stray: 0, lightThreshold: 0 };
    if (!dm || W < 16 || H < 16) { res.reason = 'too-small'; return res; }
    var x, y, i, k, gx, gy;

    // 1) 종이 밝기: 듬성듬성 뽑은 밝은 픽셀(d ≤ T)의 중앙값 → tL
    var hist = new Uint32Array(256), nLight = 0, med = 0;
    var sy = Math.max(1, Math.floor(H / 400)), sx = Math.max(1, Math.floor(W / 400));
    for (y = 0; y < H; y += sy) for (k = y * W, x = 0; x < W; x += sx) hist[dm[k + x]]++;
    for (i = 0; i <= T; i++) nLight += hist[i];
    for (i = 0, k = 0; i <= T; i++) { k += hist[i]; if (k * 2 >= nLight) { med = i; break; } }
    var tL = opts.lightThreshold || Math.min(T, Math.max(10, med + 10));
    res.lightThreshold = tL;

    // 2) 칸별 개수: d > tL(꽉 참 판정), d > T(진한 픽셀). 칸이 4px 이상이면 칸 안에서
    //    두 줄에 한 줄, 두 칸에 한 칸만 본다(표본 수는 칸마다 세어 둔다).
    var st = cell >= 4 ? 2 : 1;
    var cntL = new Int32Array(N), cntT = new Int32Array(N);
    var colN = new Int32Array(gw), rowN = new Int32Array(gh);
    for (gx = 0; gx < gw; gx++) colN[gx] = Math.ceil((Math.min(W, gx * cell + cell) - gx * cell) / st);
    for (gy = 0; gy < gh; gy++) rowN[gy] = Math.ceil((Math.min(H, gy * cell + cell) - gy * cell) / st);
    for (gy = 0; gy < gh; gy++) {
      var rb = gy * gw, yEnd = Math.min(H, gy * cell + cell);
      for (y = gy * cell; y < yEnd; y += st) {
        var k0 = y * W;
        for (gx = 0, x = 0; gx < gw; gx++, x += cell) {
          var ke = k0 + Math.min(W, x + cell), nl = 0, nt = 0, d;
          for (var kk = k0 + x; kk < ke; kk += st) { d = dm[kk]; nl += d > tL ? 1 : 0; nt += d > T ? 1 : 0; }
          if (nl) { cntL[rb + gx] += nl; cntT[rb + gx] += nt; }
        }
      }
    }
    var raw = new Uint8Array(N), inkTotal = 0;
    for (gy = 0, i = 0; gy < gh; gy++) for (gx = 0; gx < gw; gx++, i++) {
      if (cntL[i] * 2 >= colN[gx] * rowN[gy]) raw[i] = 1;
      inkTotal += cntT[i];
    }

    // 3) 닫기(3×3) → 4-연결 성분 + 구멍 메우기(가로 줄 단위 run 과 union-find 로 한 번에)
    var mask = splitMorph(splitMorph(raw, gw, gh, 1, true), gw, gh, 1, false);
    var nLab = splitLabel(mask, gw, gh, labels);
    if (!nLab) { res.reason = 'blank'; return res; }
    var L; // 라벨 임시 변수

    // 4) 성분 통계(넓이, 닫기 전 꽉 찬 칸 수, 칸 상자)
    var area = new Int32Array(nLab + 1), rawN = new Int32Array(nLab + 1);
    var bx0 = new Int32Array(nLab + 1).fill(gw), by0 = new Int32Array(nLab + 1).fill(gh), bx1 = new Int32Array(nLab + 1).fill(-1), by1 = new Int32Array(nLab + 1).fill(-1);
    for (gy = 0, i = 0; gy < gh; gy++) for (gx = 0; gx < gw; gx++, i++) {
      L = labels[i];
      if (!L) continue;
      area[L]++; rawN[L] += raw[i];
      if (gx < bx0[L]) bx0[L] = gx; if (gx > bx1[L]) bx1[L] = gx;
      if (gy < by0[L]) by0[L] = gy; if (gy > by1[L]) by1[L] = gy;
    }
    // 조각(페이지의 0.2% 이상)만 자세히: 행별 좌우 끝, 열별 위아래 끝
    var pieceOf = new Int32Array(nLab + 1).fill(-1), pieces = [];
    for (L = 1; L <= nLab; L++) {
      if (area[L] < 0.002 * N) continue;
      pieceOf[L] = pieces.length;
      var pw = bx1[L] - bx0[L] + 1, ph = by1[L] - by0[L] + 1;
      pieces.push({ label: L, labs: [L], area: area[L], raw: rawN[L], gx0: bx0[L], gy0: by0[L], gx1: bx1[L], gy1: by1[L],
        rowL: new Int32Array(ph).fill(-1), rowR: new Int32Array(ph).fill(-1), colT: new Int32Array(pw).fill(-1), colB: new Int32Array(pw).fill(-1) });
    }
    pieces.forEach(function (P) { splitEnvelope(P, labels, gw); });
    pieces.forEach(function (c) { c.rect = splitMinRect(splitHullPts(c)); c.fill = c.area / c.rect.area; });

    // 5) 흰 띠로 갈라진 한 장 다시 합치기
    if (opts.mergeBands !== false && pieces.length > 1) splitMergeBands(pieces, labels, 0.6 * minGap / cell);

    if (opts.debug) res.pieces = pieces.map(function (c) {
      return { label: c.label, area: c.area / N, raw: c.raw / c.area, fill: c.fill, short: c.rect.short / Math.min(gw, gh), merged: !!c.merged, mergedInto: c.mergedInto || 0 };
    });

    // 6) 사진 후보
    //    꽉 찬 칸 비율 ≥ 0.7(글자 덩어리는 0.55 이하), 두께 ≥ 짧은 변의 5%(스캐너 가장자리 띠 제외),
    //    넓이 ≥ 1.5%, 기운 사각형 채움 ≥ 0.5(ㄱ자 가장자리 띠 등 제외). 0.3~1.5% 라도 반듯한 사각형(채움 ≥ 0.85, 두께 ≥ 3%)이면 작은 사진으로 본다.
    var minCells = (opts.minArea || 0.015) * N, shortCells = Math.min(gw, gh);
    var cands = pieces.filter(function (c) {
      if (c.mergedInto || c.raw < 0.7 * c.area) return false;
      if (c.area >= minCells && c.rect.short >= 0.05 * shortCells && (c.merged || c.fill >= 0.5)) return true;
      return c.area >= 0.003 * N && c.fill >= 0.85 && c.rect.short >= 0.03 * shortCells;
    });
    if (!cands.length) { res.reason = 'no-photo'; return res; }

    // 후보 밖에 남은 진한 픽셀 비율(후보 성분을 1칸 넓혀서 잰다)
    var candLab = new Uint8Array(nLab + 1), inkOut = 0;
    cands.forEach(function (c) { candLab[c.label] = 1; });
    for (gy = 0, i = 0; gy < gh; gy++) for (gx = 0; gx < gw; gx++, i++) {
      if (!cntT[i] || candLab[labels[i]]) continue;
      var nearC = false;
      for (var dy = -1; dy <= 1 && !nearC; dy++) {
        var yy = gy + dy; if (yy < 0 || yy >= gh) continue;
        for (var dx = -1; dx <= 1; dx++) { var xx = gx + dx; if (xx >= 0 && xx < gw && candLab[labels[yy * gw + xx]]) { nearC = true; break; } }
      }
      if (!nearC) inkOut += cntT[i];
    }
    res.stray = inkTotal ? inkOut / inkTotal : 0;

    // 7) 픽셀 단위 상자 → 읽는 순서
    var regs = cands.map(function (c) { return splitPixelBox(a, labels, gw, gh, cell, c, tL); });
    regs = orderRegions(regs);
    if (regs.length >= 2 && res.stray > (opts.maxStray == null ? 0.1 : opts.maxStray)) {
      res.reason = 'stray-content'; res.candidates = regs;
      return res;
    }
    res.regions = regs; res.split = regs.length >= 2;
    res.reason = res.split ? 'split' : 'single';
    return res;
  }

  // 이진 격자 팽창(dilate=true, 격자 밖=0) / 침식(false, 격자 밖=1). 반지름 r 정사각형 = 3×3 을 r번.
  function splitMorph(src, gw, gh, r, dilate) {
    var cur = src, x, y, b, n = gw * gh;
    for (var it = 0; it < r; it++) {
      var tmp = new Uint8Array(n), out = new Uint8Array(n);
      if (dilate) {
        for (y = 0; y < gh; y++) {
          b = y * gw; tmp[b] = cur[b] | (gw > 1 ? cur[b + 1] : 0);
          for (x = 1; x < gw - 1; x++) tmp[b + x] = cur[b + x - 1] | cur[b + x] | cur[b + x + 1];
          if (gw > 1) tmp[b + gw - 1] = cur[b + gw - 2] | cur[b + gw - 1];
        }
        for (x = 0; x < gw; x++) out[x] = tmp[x] | (gh > 1 ? tmp[x + gw] : 0);
        for (b = gw; b < n - gw; b++) out[b] = tmp[b - gw] | tmp[b] | tmp[b + gw];
        if (gh > 1) for (b = n - gw; b < n; b++) out[b] = tmp[b - gw] | tmp[b];
      } else {
        for (y = 0; y < gh; y++) {
          b = y * gw; tmp[b] = cur[b] & (gw > 1 ? cur[b + 1] : 1);
          for (x = 1; x < gw - 1; x++) tmp[b + x] = cur[b + x - 1] & cur[b + x] & cur[b + x + 1];
          if (gw > 1) tmp[b + gw - 1] = cur[b + gw - 2] & cur[b + gw - 1];
        }
        for (x = 0; x < gw; x++) out[x] = tmp[x] & (gh > 1 ? tmp[x + gw] : 1);
        for (b = gw; b < n - gw; b++) out[b] = tmp[b - gw] & tmp[b] & tmp[b + gw];
        if (gh > 1) for (b = n - gw; b < n; b++) out[b] = tmp[b - gw] & tmp[b];
      }
      cur = out;
    }
    return cur;
  }

  /* 4-연결 성분 라벨링 + 구멍 메우기. 각 행을 같은 값의 구간(run)으로 나누고, 위아래로 겹치는
   * 같은 종류 구간을 union-find 로 잇는다. 가장자리에 닿지 않는 빈 덩어리가 내용 성분 하나에만
   * 닿아 있으면 그 성분의 구멍으로 보고 같은 라벨을 준다. 반환값 = 성분 수(라벨 1..n). */
  function splitLabel(mask, gw, gh, labels) {
    var x, y, b, i, j, n = 0;
    for (y = 0; y < gh; y++) { b = y * gw; n++; for (x = 1; x < gw; x++) if (mask[b + x] !== mask[b + x - 1]) n++; }
    var rs = new Int32Array(n), re = new Int32Array(n), rowStart = new Int32Array(gh + 1), par = new Int32Array(n);
    for (y = 0, j = 0; y < gh; y++) {
      b = y * gw; rowStart[y] = j; rs[j] = 0;
      for (x = 1; x < gw; x++) if (mask[b + x] !== mask[b + x - 1]) { re[j] = x - 1; j++; rs[j] = x; }
      re[j] = gw - 1; j++;
    }
    rowStart[gh] = n;
    for (i = 0; i < n; i++) par[i] = i;
    function find(a) { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; }
    function fg(r, yy) { return mask[yy * gw + rs[r]]; }
    // 위 행과 겹치는 구간 쌍마다 visit(위, 아래) 호출
    function overlaps(visit) {
      for (var yy = 1; yy < gh; yy++) {
        var p = rowStart[yy - 1], pe = rowStart[yy], q = rowStart[yy], qe = rowStart[yy + 1];
        while (p < pe && q < qe) {
          visit(p, q, yy);
          if (re[p] < re[q]) p++; else if (re[q] < re[p]) q++; else { p++; q++; }
        }
      }
    }
    overlaps(function (p, q, yy) {
      if (fg(p, yy - 1) === fg(q, yy)) { var a = find(p), c = find(q); if (a !== c) par[a < c ? c : a] = a < c ? a : c; }
    });
    // 가장자리 빈 덩어리 표시, 빈 덩어리별 주인(닿는 내용 성분: 0=없음, -1=여럿)
    var border = new Uint8Array(n), owner = new Int32Array(n);
    for (y = 0; y < gh; y++) for (i = rowStart[y]; i < rowStart[y + 1]; i++) {
      if (fg(i, y)) continue;
      if (y === 0 || y === gh - 1 || rs[i] === 0 || re[i] === gw - 1) border[find(i)] = 1;
    }
    function own(bgRun, fgRun) {
      var r = find(bgRun), f = find(fgRun) + 1;
      if (border[r]) return;
      owner[r] = owner[r] === 0 || owner[r] === f ? f : -1;
    }
    for (y = 0; y < gh; y++) for (i = rowStart[y]; i + 1 < rowStart[y + 1]; i++) {
      if (fg(i, y)) own(i + 1, i); else own(i, i + 1);
    }
    overlaps(function (p, q, yy) {
      var a = fg(p, yy - 1), c = fg(q, yy);
      if (a !== c) { if (a) own(q, p); else own(p, q); }
    });
    // 라벨 매기기(래스터 순서) 후 기록
    var lab = new Int32Array(n), nLab = 0;
    for (y = 0; y < gh; y++) for (i = rowStart[y]; i < rowStart[y + 1]; i++) {
      var r = find(i), L = 0;
      if (fg(i, y)) { if (!lab[r]) lab[r] = ++nLab; L = lab[r]; }
      else if (!border[r] && owner[r] > 0) {
        var o = find(owner[r] - 1);
        if (!lab[o]) lab[o] = ++nLab;
        L = lab[o];
      }
      if (L) labels.fill(L, y * gw + rs[i], y * gw + re[i] + 1);
    }
    return nLab;
  }

  // 조각의 볼록 껍질 꼭짓점을 모두 포함하는 점들: 각 행 양 끝 칸의 모서리
  function splitHullPts(c) {
    var pts = [];
    for (var r = 0; r < c.rowL.length; r++) {
      if (c.rowL[r] < 0) continue;
      var y = c.gy0 + r, l = c.rowL[r], rr = c.rowR[r] + 1;
      pts.push(l, y, l, y + 1, rr, y, rr, y + 1);
    }
    return pts;
  }

  // 최소 넓이 기운 사각형(±15°): 1° 간격으로 찾은 뒤 ±0.5° 를 더 본다
  function splitMinRect(pts) {
    function at(deg) {
      var r = deg * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
      var u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (var i = 0; i < pts.length; i += 2) {
        var u = pts[i] * cs + pts[i + 1] * sn, v = pts[i + 1] * cs - pts[i] * sn;
        if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
      }
      return { area: (u1 - u0) * (v1 - v0), deg: deg, short: Math.min(u1 - u0, v1 - v0) };
    }
    var best = at(0), deg, c;
    for (deg = -15; deg <= 15; deg++) if (deg && (c = at(deg)).area < best.area) best = c;
    var d0 = best.deg;
    if ((c = at(d0 - 0.5)).area < best.area) best = c;
    if ((c = at(d0 + 0.5)).area < best.area) best = c;
    return best;
  }

  // 조각의 행별 좌우 끝 · 열별 위아래 끝(상자 끝에서 안쪽으로 찾는다)
  function splitEnvelope(P, labels, gw) {
    var L = P.label, gx, gy, b;
    for (gy = P.gy0; gy <= P.gy1; gy++) {
      b = gy * gw;
      for (gx = P.gx0; gx <= P.gx1 && labels[b + gx] !== L; gx++);
      if (gx > P.gx1) continue;
      P.rowL[gy - P.gy0] = gx;
      for (gx = P.gx1; labels[b + gx] !== L; gx--);
      P.rowR[gy - P.gy0] = gx;
    }
    for (gx = P.gx0; gx <= P.gx1; gx++) {
      for (gy = P.gy0; gy <= P.gy1 && labels[gy * gw + gx] !== L; gy++);
      if (gy > P.gy1) continue;
      P.colT[gx - P.gx0] = gy;
      for (gy = P.gy1; labels[gy * gw + gx] !== L; gy--);
      P.colB[gx - P.gx0] = gy;
    }
  }

  /* 흰 띠 합치기. 두 조각을 합친 기운 사각형의 축(u: 띠 방향, v: 띠를 가로지르는 방향)에서
   *  - 두 조각의 u 범위 양 끝이 맞고(둘 다 사진 폭 전체에 걸침),
   *  - v 방향으로 떨어져 있고 그 틈이 두 조각 중 얇은 쪽 두께 이하이며,
   *  - 마주 보는 변 중 하나라도 들쭉날쭉하거나(직선에서 평균 1.5칸 넘게 벗어남),
   *    틈(중앙값)이 thinGap 칸 이하(최소 틈의 60%, 가는 흰 선)이면 합친다.
   * 따로 놓인 진짜 사진 두 장은 마주 보는 변이 둘 다 곧고 틈이 넓어 합쳐지지 않는다. */
  function splitMergeBands(pieces, labels, thinGap) {
    for (var guard = 0; guard < 20; guard++) {
      var live = pieces.filter(function (c) { return !c.mergedInto; }), hit = null;
      for (var i = 0; i < live.length && !hit; i++) {
        for (var j = i + 1; j < live.length && !hit; j++) {
          var A = live[i], B = live[j];
          var ox = Math.min(A.gx1, B.gx1) - Math.max(A.gx0, B.gx0), oy = Math.min(A.gy1, B.gy1) - Math.max(A.gy0, B.gy0);
          var minW = Math.min(A.gx1 - A.gx0, B.gx1 - B.gx0), minH = Math.min(A.gy1 - A.gy0, B.gy1 - B.gy0);
          // 위아래로 놓였고 가로 범위가 거의 같거나, 좌우로 놓였고 세로 범위가 거의 같을 때만
          var vert = ox >= 0.8 * minW && -oy <= minH, horiz = oy >= 0.8 * minH && -ox <= minW;
          if ((vert || horiz) && splitBandPair(A, B, vert, horiz, thinGap)) hit = [A, B];
        }
      }
      if (!hit) break;
      splitJoin(hit[0], hit[1]);
    }
    var remap = null;
    pieces.forEach(function (c) {
      if (c.mergedInto || c.labs.length < 2) return;
      remap = remap || {};
      c.labs.forEach(function (L) { if (L !== c.label) remap[L] = c.label; });
    });
    if (remap) for (var k = 0; k < labels.length; k++) { var r = labels[k] && remap[labels[k]]; if (r) labels[k] = r; }
  }

  function splitBandPair(A, B, vert, horiz, thinGap) {
    var rect = splitMinRect(splitHullPts(A).concat(splitHullPts(B)));
    var r = rect.deg * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
    for (var dir = 0; dir < 2; dir++) {
      if (dir === 0 && !vert) continue;
      if (dir === 1 && !horiz) continue;
      // dir 0: 가로 띠 → 마주 보는 변은 열별 위/아래 끝. dir 1: 세로 띠 → 행별 왼/오른 끝.
      var ea = splitEdges(A, cs, sn, dir), eb = splitEdges(B, cs, sn, dir);
      var ext = Math.max(ea.u1, eb.u1) - Math.min(ea.u0, eb.u0), tol = Math.max(3, ext * 0.03);
      if (Math.abs(ea.u0 - eb.u0) > tol || Math.abs(ea.u1 - eb.u1) > tol) continue;
      var f = ea.vmid < eb.vmid ? ea : eb, s = f === ea ? eb : ea;
      var lo = Math.ceil(Math.max(ea.u0, eb.u0) + ext * 0.1), hi = Math.floor(Math.min(ea.u1, eb.u1) - ext * 0.1);
      if (hi - lo < 10) continue;
      var p1 = [], p2 = [], gaps = [];
      for (var u = lo; u <= hi; u++) {
        var a1 = f.hiV[u - f.base], b1 = s.loV[u - s.base];
        if (a1 === undefined || b1 === undefined) continue;
        p1.push(u, a1); p2.push(u, b1); gaps.push(b1 - a1);
      }
      if (gaps.length < 10) continue;
      gaps.sort(function (x, y) { return x - y; });
      var g = gaps[gaps.length >> 1];
      if (g <= 0 || g > Math.min(f.v1 - f.v0, s.v1 - s.v0)) continue;
      // 들쭉날쭉한 변(날아간 흰 하늘 등)으로 합치는 건 틈이 좁을 때만: 크기가 같은 사진 두 장이
      // 나란히 놓였는데 한쪽 가장자리가 밝아 들쭉날쭉해 보이는 흔한 경우를 잘못 합치지 않도록.
      if (g <= thinGap || (g <= thinGap * 3 && Math.max(splitResidual(p1), splitResidual(p2)) > 1.5)) return true;
    }
    return false;
  }

  // 기운 좌표(u,v)에서 조각의 위쪽(작은 v)/아래쪽(큰 v) 끝 윤곽을 u 1칸 단위로
  function splitEdges(c, cs, sn, dir) {
    var loV = [], hiV = [], u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity, pts = [], n, t;
    if (dir === 0) {
      for (t = 0; t < c.colT.length; t++) if (c.colT[t] >= 0) pts.push(c.gx0 + t + 0.5, c.colT[t], c.gx0 + t + 0.5, c.colB[t] + 1);
    } else {
      for (t = 0; t < c.rowL.length; t++) if (c.rowL[t] >= 0) pts.push(c.rowL[t], c.gy0 + t + 0.5, c.rowR[t] + 1, c.gy0 + t + 0.5);
    }
    n = pts.length;
    var U = new Float64Array(n / 2), V = new Float64Array(n / 2);
    for (t = 0; t < n; t += 2) {
      var X = pts[t], Y = pts[t + 1], uu = X * cs + Y * sn, vv = -X * sn + Y * cs;
      if (dir) { var sw = uu; uu = vv; vv = sw; }
      U[t >> 1] = uu; V[t >> 1] = vv;
      if (uu < u0) u0 = uu; if (uu > u1) u1 = uu; if (vv < v0) v0 = vv; if (vv > v1) v1 = vv;
    }
    var base = Math.floor(u0);
    for (t = 0; t < U.length; t++) {
      var s = Math.floor(U[t]) - base, v = V[t];
      if (loV[s] === undefined || v < loV[s]) loV[s] = v;
      if (hiV[s] === undefined || v > hiV[s]) hiV[s] = v;
    }
    return { loV: loV, hiV: hiV, base: base, u0: u0, u1: u1, v0: v0, v1: v1, vmid: (v0 + v1) / 2 };
  }

  // 최소제곱 직선에서의 평균 절대 잔차
  function splitResidual(pts) {
    var n = pts.length / 2, su = 0, sv = 0, suu = 0, suv = 0, i;
    for (i = 0; i < pts.length; i += 2) { su += pts[i]; sv += pts[i + 1]; suu += pts[i] * pts[i]; suv += pts[i] * pts[i + 1]; }
    var den = n * suu - su * su, m = den ? (n * suv - su * sv) / den : 0, c = (sv - m * su) / n, e = 0;
    for (i = 0; i < pts.length; i += 2) e += Math.abs(pts[i + 1] - (m * pts[i] + c));
    return e / n;
  }

  // B를 A에 합친다(윤곽 배열은 합친 상자 크기로 다시 만든다)
  function splitJoin(A, B) {
    var gx0 = Math.min(A.gx0, B.gx0), gy0 = Math.min(A.gy0, B.gy0), gx1 = Math.max(A.gx1, B.gx1), gy1 = Math.max(A.gy1, B.gy1);
    var rowL = new Int32Array(gy1 - gy0 + 1).fill(-1), rowR = new Int32Array(gy1 - gy0 + 1).fill(-1);
    var colT = new Int32Array(gx1 - gx0 + 1).fill(-1), colB = new Int32Array(gx1 - gx0 + 1).fill(-1);
    [A, B].forEach(function (c) {
      var t, j;
      for (t = 0; t < c.rowL.length; t++) {
        if (c.rowL[t] < 0) continue;
        j = c.gy0 + t - gy0;
        rowL[j] = rowL[j] < 0 ? c.rowL[t] : Math.min(rowL[j], c.rowL[t]);
        rowR[j] = Math.max(rowR[j], c.rowR[t]);
      }
      for (t = 0; t < c.colT.length; t++) {
        if (c.colT[t] < 0) continue;
        j = c.gx0 + t - gx0;
        colT[j] = colT[j] < 0 ? c.colT[t] : Math.min(colT[j], c.colT[t]);
        colB[j] = Math.max(colB[j], c.colB[t]);
      }
    });
    A.gx0 = gx0; A.gy0 = gy0; A.gx1 = gx1; A.gy1 = gy1;
    A.rowL = rowL; A.rowR = rowR; A.colT = colT; A.colB = colB;
    A.area += B.area; A.raw += B.raw; A.labs = A.labs.concat(B.labs);
    A.rect = splitMinRect(splitHullPts(A)); A.fill = A.area / A.rect.area;
    A.merged = true; B.mergedInto = A.label;
  }

  // 성분의 픽셀 단위 상자. 바깥 끝은 칸 상자의 가장 바깥 칸과 그 바로 바깥 칸에만 있으므로
  // 그 띠에서 (자기 성분이거나 자기 성분에 붙은) 칸의 d > tL 픽셀만 본다.
  function splitPixelBox(a, labels, gw, gh, cell, c, tL) {
    var W = a.w, H = a.h, dm = a.dmap, own = c.label;
    var x0 = c.gx0 * cell, y0 = c.gy0 * cell, x1 = Math.min(W, (c.gx1 + 1) * cell) - 1, y1 = Math.min(H, (c.gy1 + 1) * cell) - 1;
    var X0 = W, Y0 = H, X1 = -1, Y1 = -1;
    function mineOrNear(gx, gy) {
      for (var dy = -1; dy <= 1; dy++) {
        var yy = gy + dy; if (yy < 0 || yy >= gh) continue;
        for (var dx = -1; dx <= 1; dx++) {
          var xx = gx + dx; if (xx >= 0 && xx < gw && labels[yy * gw + xx] === own) return true;
        }
      }
      return false;
    }
    function scan(gx, gy) {
      if (gx < 0 || gy < 0 || gx >= gw || gy >= gh || !mineOrNear(gx, gy)) return;
      var px0 = gx * cell, py0 = gy * cell, px1 = Math.min(W, px0 + cell) - 1, py1 = Math.min(H, py0 + cell) - 1;
      for (var y = py0; y <= py1; y++) for (var x = px0, k = y * W + px0; x <= px1; x++, k++) {
        if (dm[k] > tL) { if (x < X0) X0 = x; if (x > X1) X1 = x; if (y < Y0) Y0 = y; if (y > Y1) Y1 = y; }
      }
    }
    var gx, gy;
    for (gy = c.gy0 - 1; gy <= c.gy1 + 1; gy++) { scan(c.gx0 - 1, gy); scan(c.gx0, gy); scan(c.gx1, gy); scan(c.gx1 + 1, gy); }
    for (gx = c.gx0 + 1; gx < c.gx1; gx++) { scan(gx, c.gy0 - 1); scan(gx, c.gy0); scan(gx, c.gy1); scan(gx, c.gy1 + 1); }
    // 띠에서 픽셀을 못 찾은 변은 칸 상자 경계를 쓴다
    return { x0: X1 >= 0 ? Math.min(X0, x0 + cell) : x0, y0: Y1 >= 0 ? Math.min(Y0, y0 + cell) : y0,
      x1: X1 >= 0 ? Math.max(X1, x1 - cell) : x1, y1: Y1 >= 0 ? Math.max(Y1, y1 - cell) : y1,
      label: own, fill: Math.round(c.fill * 1000) / 1000 };
  }

  /* 읽는 순서: 세로 범위가 (작은 쪽 높이의) 절반 넘게 겹치면 같은 줄.
   * 줄은 위→아래, 줄 안에서는 왼쪽→오른쪽. */
  function orderRegions(regions) {
    var s = regions.slice().sort(function (p, q) { return (p.y0 + p.y1) - (q.y0 + q.y1) || p.x0 - q.x0; });
    var rows = [];
    s.forEach(function (r) {
      var h = r.y1 - r.y0 + 1, best = null, bestOv = 0;
      rows.forEach(function (row) {
        var ov = 0;
        row.items.forEach(function (o) {
          var v = Math.min(o.y1, r.y1) - Math.max(o.y0, r.y0) + 1;
          ov = Math.max(ov, v / Math.min(h, o.y1 - o.y0 + 1));
        });
        if (ov > 0.5 && ov > bestOv) { bestOv = ov; best = row; }
      });
      if (best) { best.items.push(r); best.top = Math.min(best.top, r.y0); }
      else rows.push({ items: [r], top: r.y0 });
    });
    rows.sort(function (p, q) { return p.top - q.top; });
    var out = [];
    rows.forEach(function (row) {
      row.items.sort(function (p, q) { return p.x0 - q.x0; });
      out.push.apply(out, row.items);
    });
    return out;
  }

  /* 영역 i의 이미지(Promise<ImageBitmap>): 상자 + 흰 여백(짧은 변의 2%, 8px 이상)을 잘라 그린 뒤,
   * 다른 사진 성분(2칸 넓힌 것)에 걸리는 칸을 흰색으로 칠한다. 자기 성분(1칸 넓힌 것)은 칠하지 않으므로
   * 기운 이웃과 상자가 겹쳐도 자기 사진은 지워지지 않는다.
   * opts: { margin(px), dilate(칸, 기본 2) } */
  function extractRegion(bitmap, a, result, i, opts) {
    opts = opts || {};
    var r = result.regions[i];
    if (!r) return Promise.reject(new Error('no-region'));
    var g = result.grid, cell = g.cell, gw = g.gw, gh = g.gh, labels = g.labels;
    var W = a.w, H = a.h;
    var m = opts.margin != null ? opts.margin : Math.max(8, Math.round(0.02 * Math.min(r.x1 - r.x0 + 1, r.y1 - r.y0 + 1)));
    var X0 = Math.max(0, r.x0 - m), Y0 = Math.max(0, r.y0 - m);
    var X1 = Math.min(W - 1, r.x1 + m), Y1 = Math.min(H - 1, r.y1 + m);
    var cw = X1 - X0 + 1, ch = Y1 - Y0 + 1;
    var canvas;
    if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(cw, ch);
    else { canvas = document.createElement('canvas'); canvas.width = cw; canvas.height = ch; }
    var ctx = canvas.getContext('2d');
    if (!ctx) return Promise.reject(new Error('canvas-too-large'));
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(bitmap, X0, Y0, cw, ch, 0, 0, cw, ch);

    var own = r.label, D = opts.dilate || 2, others = {};
    result.regions.forEach(function (o) { if (o.label !== own) others[o.label] = 1; });
    // 칸 창: 잘라 낸 사각형에 걸치는 칸 + 넓힐 거리
    var gx0 = Math.floor(X0 / cell), gy0 = Math.floor(Y0 / cell), gx1 = Math.floor(X1 / cell), gy1 = Math.floor(Y1 / cell);
    var ex0 = Math.max(0, gx0 - D), ey0 = Math.max(0, gy0 - D), ex1 = Math.min(gw - 1, gx1 + D), ey1 = Math.min(gh - 1, gy1 + D);
    var ww = ex1 - ex0 + 1, hh = ey1 - ey0 + 1;
    var oth = new Uint8Array(ww * hh), mine = new Uint8Array(ww * hh), any = false, x, y;
    for (y = 0; y < hh; y++) for (x = 0; x < ww; x++) {
      var L = labels[(ey0 + y) * gw + ex0 + x];
      if (L === own) mine[y * ww + x] = 1;
      else if (L && others[L]) { oth[y * ww + x] = 1; any = true; }
    }
    if (any) {
      var othD = splitMorph(oth, ww, hh, D, true), mineD = splitMorph(mine, ww, hh, 1, true);
      for (y = gy0; y <= gy1; y++) {
        var run = -1;
        for (x = gx0; x <= gx1 + 1; x++) {
          var j = (y - ey0) * ww + (x - ex0);
          var paint = x <= gx1 && othD[j] && !mineD[j];
          if (paint && run < 0) run = x;
          if (!paint && run >= 0) { ctx.fillRect(run * cell - X0, y * cell - Y0, (x - run) * cell, cell); run = -1; }
        }
      }
    }
    return createImageBitmap(canvas);
  }

  window.WhiteCrop = {
    DEFAULTS: DEFAULTS,
    analyzeBitmap: analyzeBitmap,
    computeContentBox: computeContentBox,
    refineBox: refineBox,
    findPhotoRegions: findPhotoRegions,
    extractRegion: extractRegion,
    orderRegions: orderRegions,
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

  var native = (window.autocroperNative && window.autocroperNative.isDesktop) ? window.autocroperNative : null;
  var SETTINGS_KEY = 'autocroper.settings.v1';
  var opts = Object.assign({}, DEFAULTS, loadSettings());
  var items = [];

  // 옵션은 이 기기에 기억해 두고 다음에 그대로 쓴다(회전은 매번 0°부터).
  function loadSettings() {
    try {
      var o = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'), out = {};
      Object.keys(DEFAULTS).forEach(function (k) {
        if (k !== 'rotation' && o[k] !== undefined && typeof o[k] === typeof DEFAULTS[k]) out[k] = o[k];
      });
      return out;
    } catch (_) { return {}; }
  }
  function saveSettings() {
    try {
      var o = Object.assign({}, opts); delete o.rotation;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(o));
    } catch (_) { /* 저장 못 해도 동작에는 지장 없음 */ }
  }
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
    split: $('#opt-split'),
    autoSave: $('#opt-autosave'),
    saveOpt: $('#save-opt'),
    saveFolder: $('#save-folder'),
    saveHint: $('#save-hint'),
    pickFolder: $('#pick-folder-btn'),
    openFolder: $('#open-folder-btn'),
    clearFolder: $('#clear-folder-btn'),
    saveAll: $('#save-all-btn'),
    exeLink: $('#exe-link'),
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
    el.split.checked = !!opts.split;
    el.autoSave.checked = !!opts.autoSave;
    el.quality.value = opts.quality;
    el.qualityOut.textContent = opts.quality;
    el.qualityRow.hidden = opts.format !== 'jpeg';
    document.querySelectorAll('[data-rot]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.rot) === opts.rotation));
    });
    document.querySelectorAll('[data-format]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.format === opts.format));
    });
    saveSettings();
    // 접힌 '고급 설정' 제목 옆에 기본값과 다르게 바꾼 옵션 수
    var changed = ['threshold', 'noise', 'padding', 'trim', 'deskew', 'split', 'format', 'quality'].filter(function (k) {
      return opts[k] !== DEFAULTS[k] && !(k === 'quality' && opts.format !== 'jpeg');
    }).length + (opts.rotation ? 1 : 0);
    var badge = document.getElementById('adv-changed');
    if (badge) { badge.hidden = !changed; badge.textContent = changed + '개 변경됨'; }
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
    scheduleRedrawAll(); saveSettings();
  });
  el.padding.addEventListener('change', syncOptionUI);
  el.trim.addEventListener('change', function () {
    opts.trim = el.trim.checked; syncOptionUI(); scheduleRedrawAll();
  });
  el.deskew.addEventListener('change', function () {
    opts.deskew = el.deskew.checked; syncOptionUI(); scheduleDeskew(0);
  });
  el.split.addEventListener('change', function () {
    opts.split = el.split.checked; syncOptionUI();
    if (opts.split) items.slice().forEach(function (it) { if (!it.group && it.base && it.base.analysis) maybeSplit(it); });
    else groupsOf(items).forEach(function (g) { unsplitGroup(g, false); });
  });
  el.autoSave.addEventListener('change', function () {
    opts.autoSave = el.autoSave.checked; syncOptionUI();
    if (opts.autoSave) items.forEach(maybeAutoSave);
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
    var rot = opts.rotation, keep = { autoSave: opts.autoSave };
    opts = Object.assign({}, DEFAULTS, keep, { rotation: rot });
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

  /* 저장 폴더
   * 데스크톱 앱: 기본 폴더 선택 창 + 파일 쓰기(설정에 기억)
   * 브라우저(Edge · Chrome): 폴더 접근 기능(showDirectoryPicker), 폴더 핸들은 IndexedDB에 기억
   * 둘 다 안 되면 지금처럼 다운로드 · ZIP */
  var saveTarget = null; // { kind: 'native', path, label } | { kind: 'fsa', handle, label }
  var canPickFolder = !!native || typeof window.showDirectoryPicker === 'function';
  var savedNames = new Map(); // 이번 실행에서 폴더에 쓴 이름 → 항목 id (서로 덮어쓰지 않도록)

  function idb(mode, fn) {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('autocroper', 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
      req.onerror = function () { reject(req.error); };
      req.onsuccess = function () {
        try {
          var tx = req.result.transaction('kv', mode), st = tx.objectStore('kv'), r = fn(st);
          tx.oncomplete = function () { resolve(r && r.result); req.result.close(); };
          tx.onerror = function () { reject(tx.error); req.result.close(); };
        } catch (err) { reject(err); req.result.close(); }
      };
    });
  }

  function setSaveTarget(t) {
    saveTarget = t;
    el.saveFolder.textContent = t ? t.label : '지정 안 함 · 다운로드 폴더로 받기';
    el.saveFolder.classList.toggle('is-set', !!t);
    el.openFolder.hidden = !(t && t.kind === 'native');
    el.clearFolder.hidden = !t;
    el.autoSave.disabled = !t;
    el.saveAll.hidden = !t;
    el.zip.className = t ? 'ghost' : 'primary';
    items.forEach(function (it) { it.ui.download.textContent = t ? '저장' : '다운로드'; });
    refreshToolbar();
  }

  function initSaveFolder() {
    if (!canPickFolder) {
      el.pickFolder.hidden = true;
      el.autoSave.closest('label').hidden = true;
      el.saveHint.textContent = '이 브라우저는 폴더에 바로 저장하는 기능을 지원하지 않습니다. Edge · Chrome이나 Windows 설치 파일을 쓰면 폴더에 바로 저장할 수 있습니다.';
      setSaveTarget(null);
      return;
    }
    setSaveTarget(null);
    if (native) {
      native.getSaveFolder().then(function (p) { if (p) setSaveTarget({ kind: 'native', path: p, label: p }); });
    } else if (window.indexedDB) {
      idb('readonly', function (st) { return st.get('saveDir'); }).then(function (h) {
        if (h && h.kind === 'directory') setSaveTarget({ kind: 'fsa', handle: h, label: h.name + ' (브라우저 폴더)' });
      }).catch(function () {});
    }
  }

  el.pickFolder.addEventListener('click', function () {
    if (native) {
      native.chooseFolder().then(function (p) { if (p) { setSaveTarget({ kind: 'native', path: p, label: p }); setStatus('저장 폴더: ' + p); } });
      return;
    }
    window.showDirectoryPicker({ id: 'autocroper-out', mode: 'readwrite' }).then(function (h) {
      setSaveTarget({ kind: 'fsa', handle: h, label: h.name + ' (브라우저 폴더)' });
      setStatus('저장 폴더: ' + h.name);
      if (window.indexedDB) idb('readwrite', function (st) { return st.put(h, 'saveDir'); }).catch(function () {});
    }).catch(function () { /* 취소 */ });
  });
  el.openFolder.addEventListener('click', function () { if (native && saveTarget) native.openFolder(saveTarget.path); });
  el.clearFolder.addEventListener('click', function () {
    setSaveTarget(null);
    opts.autoSave = false; syncOptionUI();
    if (native) { /* 데스크톱은 다음 선택 때 덮어씀 */ }
    else if (window.indexedDB) idb('readwrite', function (st) { return st.delete('saveDir'); }).catch(function () {});
  });

  // 브라우저 폴더는 권한을 다시 물어야 할 수 있다(사용자가 누른 순간에만 물을 수 있음).
  function ensurePermission(t, interactive) {
    if (t.kind !== 'fsa') return Promise.resolve(true);
    var o = { mode: 'readwrite' };
    return t.handle.queryPermission(o).then(function (st) {
      if (st === 'granted') return true;
      if (!interactive) return false;
      return t.handle.requestPermission(o).then(function (r) { return r === 'granted'; });
    }).catch(function () { return false; });
  }

  function nameFor(it, used) {
    var n = outputName(it.name, opts.format, it.part);
    if (used) return uniqueName(n, used);
    var owner = savedNames.get(n);
    if (owner === undefined || owner === it.id) { savedNames.set(n, it.id); return n; }
    var dot = n.lastIndexOf('.');
    for (var k = 2; ; k++) {
      var cand = n.slice(0, dot) + ' (' + k + ')' + n.slice(dot), o2 = savedNames.get(cand);
      if (o2 === undefined || o2 === it.id) { savedNames.set(cand, it.id); return cand; }
    }
  }

  function writeToFolder(t, name, blob) {
    if (t.kind === 'native') {
      return blob.arrayBuffer().then(function (buf) { return native.saveFile(t.path, name, buf); }).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || '저장 실패');
        return r.path || name;
      });
    }
    return t.handle.getFileHandle(name, { create: true }).then(function (fh) {
      return fh.createWritable().then(function (w) {
        return w.write(blob).then(function () { return w.close(); });
      });
    }).then(function () { return name; });
  }

  function saveItem(it, interactive, used) {
    var t = saveTarget;
    return ensurePermission(t, interactive).then(function (ok) {
      if (!ok) throw new Error('폴더 쓰기 권한이 없습니다. "폴더에 모두 저장"을 눌러 허용해 주세요.');
      return makeBlob(it);
    }).then(function (blob) {
      return writeToFolder(t, nameFor(it, used), blob);
    }).then(function (path) {
      it.saved = true;
      return path;
    });
  }

  // 처리되면 바로 저장(한 항목당 한 번). 옵션을 바꾼 뒤 다시 저장하려면 '저장' · '폴더에 모두 저장'.
  function maybeAutoSave(it) {
    if (!opts.autoSave || !saveTarget || it.saved || it.autoSaving || !it.plan || it.error || it.removed || it.skewBusy) return;
    it.autoSaving = true;
    saveItem(it, false).then(function (path) {
      setItemMsg(it, '저장됨: ' + path, 'info');
    }).catch(function (err) {
      setItemMsg(it, errText(err), 'warn');
    }).then(function () { it.autoSaving = false; });
  }

  /* 이미지 항목
   * src.file: 사용자가 넣은 파일 / src.bitmap(Promise 가능): 분리된 사진 또는 분리 취소로 되돌린 원본
   * src.group · part · count: 한 파일에서 나온 여러 장 중 몇 번째인지 */
  function addItem(file, src) {
    src = src || {};
    var node = el.tpl.content.firstElementChild.cloneNode(true);
    var it = {
      id: ++itemSeq,
      file: file,
      src: src,
      name: src.name || (file && (file.displayName || file.name)) || 'image.png',
      group: src.group || null,
      part: src.part || 0,
      count: src.count || 0,
      noSplit: !!src.noSplit,
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
      saved: false,
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
        download: $('.dl-btn', node),
        unsplit: $('.unsplit-btn', node)
      }
    };
    it.ui.name.textContent = it.name;
    it.ui.name.title = it.name;
    if (it.part) {
      var tag = document.createElement('span');
      tag.className = 'card-part';
      tag.textContent = it.part + ' / ' + it.count;
      it.ui.name.appendChild(tag);
      it.ui.unsplit.hidden = false;
      it.ui.unsplit.addEventListener('click', function () { unsplitGroup(it.group, true); });
      it.group.children.push(it);
    }
    node.classList.add('is-loading');
    setItemMsg(it, '차례를 기다리는 중…', 'info');
    $('.rm-btn', node).addEventListener('click', function () { removeItem(it); });
    $('.rot-left', node).addEventListener('click', function () { setItemRotation(it, (it.rot + 270) % 360); });
    $('.rot-right', node).addEventListener('click', function () { setItemRotation(it, (it.rot + 90) % 360); });
    it.ui.download.addEventListener('click', function () { downloadOne(it); });
    it.ui.download.textContent = saveTarget ? '저장' : '다운로드';
    it.ui.rotLabel.textContent = it.rot + '°';
    if (src.before && src.before.parentNode === el.list) {
      el.list.insertBefore(node, src.before);
      var at = items.indexOf(src.beforeItem);
      if (at >= 0) items.splice(at, 0, it); else items.push(it);
    } else {
      el.list.appendChild(node);
      items.push(it);
    }
    refreshToolbar();
    withLoadSlot(function () { return it.removed ? null : loadItem(it); });
    return it;
  }

  /* 한꺼번에 많이 넣어도 동시에 펼치는 이미지는 (워커 수 + 1)장까지만: 메모리를 아끼고,
   * 앞의 결과가 먼저 나오며, 전체도 덜 버벅인다. */
  var LOAD_MAX = POOL_SIZE + 1, loadActive = 0, loadWait = [];
  function withLoadSlot(fn) {
    return new Promise(function (resolve) { loadWait.push(resolve); pumpLoad(); }).then(function () {
      var release = function () { loadActive--; pumpLoad(); };
      return Promise.resolve().then(fn).then(release, release);
    });
  }
  function pumpLoad() {
    while (loadActive < LOAD_MAX && loadWait.length) { loadActive++; loadWait.shift()(); }
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
    var source = it.src.bitmap ? Promise.resolve(it.src.bitmap) : decode(it.file);
    return source.then(function (bmp) {
      if (it.removed) { closeBitmap(bmp); return; }
      var w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
      var base = { bitmap: bmp, w: w, h: h, analysis: null, preview: null, previewScale: 1, angle: 0 };
      it.base = base;
      it.bitmap = bmp; it.w = w; it.h = h;
      setItemMsg(it, '여백 분석 중…', 'info');
      // 분석(워커 풀)과 미리보기 축소를 동시에 시작한다.
      var t0 = performance.now();
      var analysis = it.src.analysis ? Promise.resolve(it.src.analysis) : analyzeBitmap(bmp);
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
        if (maybeSplit(it)) return; // 여러 장이면 이 카드는 사진별 카드로 바뀐다
        return syncDeskew(it).then(function () {
          if (it.removed) return;
          if (!it.state) applyState(it, base);
          it.node.classList.remove('is-loading');
          updateItem(it);
          maybeAutoSave(it);
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

  /* 여러 장 분리: 원본 분석에서 사진 영역을 찾아 2곳 이상이면 사진별 항목으로 바꾼다.
   * 원본 비트맵 · 분석은 그룹에 남겨 두어 '분리 취소'하면 다시 분석하지 않고 되돌린다. */
  function maybeSplit(it) {
    if (!opts.split || it.noSplit || it.group || it.removed || !it.base || !it.base.analysis) return false;
    if (typeof findPhotoRegions !== 'function' || typeof extractRegion !== 'function') return false;
    var res;
    try { res = findPhotoRegions(it.base.analysis, opts.threshold, {}); } catch (_) { return false; }
    if (!res || !res.regions || res.regions.length < 2) return false;
    var group = { name: it.name, file: it.file, bitmap: it.base.bitmap, analysis: it.base.analysis, children: [] };
    var n = res.regions.length;
    for (var i = 0; i < n; i++) {
      addItem(null, {
        bitmap: extractRegion(it.base.bitmap, it.base.analysis, res, i, {}),
        name: it.name, group: group, part: i + 1, count: n,
        before: it.node, beforeItem: it
      });
    }
    detachItem(it, false); // 원본 비트맵은 그룹이 가진다
    setStatus(it.name + ': 사진 ' + n + '장을 찾아 나눴습니다.');
    return true;
  }

  function unsplitGroup(group, byUser) {
    var kids = group.children.filter(function (c) { return !c.removed; });
    if (!kids.length) return;
    var first = kids[0];
    addItem(group.file, { bitmap: group.bitmap, analysis: group.analysis, name: group.name, noSplit: !!byUser, before: first.node, beforeItem: first });
    group.children = [];
    kids.forEach(function (c) { c.group = null; removeItem(c); });
  }

  function groupsOf(list) {
    var gs = [];
    list.forEach(function (it) { if (it.group && gs.indexOf(it.group) < 0) gs.push(it.group); });
    return gs;
  }

  // keepBitmaps=false: 원본 비트맵은 남기고 카드만 뺀다
  function detachItem(it, closeBase) {
    it.removed = true;
    if (closeBase && it.base) closeBitmap(it.base.bitmap);
    it.skewCache.forEach(function (st) { closeBitmap(st.bitmap); });
    it.skewCache.clear();
    it.node.remove();
    items = items.filter(function (x) { return x !== it; });
    refreshToolbar();
  }

  function removeItem(it) {
    var g = it.group;
    detachItem(it, true);
    if (g) {
      g.children = g.children.filter(function (c) { return c !== it; });
      if (!g.children.length) closeBitmap(g.bitmap); // 마지막 조각까지 지우면 원본도 놓는다
    }
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
    if (err && err.message === 'canvas-too-large') return '이미지가 너무 커서 이 기기의 브라우저에서 결과를 만들 수 없습니다.';
    if (err && /권한/.test(err.message)) return err.message;
    return '저장하지 못했습니다: ' + ((err && err.message) || err);
  }

  function downloadOne(it) {
    if (!it.plan) return;
    var btn = it.ui.download;
    btn.disabled = true;
    var label = btn.textContent;
    btn.textContent = saveTarget ? '저장 중…' : '만드는 중…';
    var job = saveTarget
      ? saveItem(it, true).then(function (path) { setItemMsg(it, '저장됨: ' + path, 'info'); })
      : makeBlob(it).then(function (blob) { saveBlob(blob, outputName(it.name, opts.format, it.part)); });
    job.catch(function (err) {
      setItemMsg(it, errText(err), 'warn');
    }).then(function () {
      btn.disabled = false; btn.textContent = label;
    });
  }

  // 폴더에 모두 저장: 워커 풀이 코어 수만큼 동시에 그리고 인코딩, 다 된 것부터 바로 쓴다.
  el.saveAll.addEventListener('click', function () {
    var ready = items.filter(function (it) { return it.plan && !it.error; });
    if (!ready.length || !saveTarget) return;
    el.saveAll.disabled = true;
    var done = 0, failed = 0, t0 = performance.now();
    ensurePermission(saveTarget, true).then(function (ok) {
      if (!ok) throw new Error('폴더 쓰기 권한이 없습니다.');
      setStatus('저장 중… 0 / ' + ready.length);
      return Promise.all(ready.map(function (it) {
        return saveItem(it, false).catch(function (err) { failed++; setItemMsg(it, errText(err), 'warn'); }).then(function () {
          done++; setStatus('저장 중… ' + done + ' / ' + ready.length);
        });
      }));
    }).then(function () {
      setStatus('폴더에 ' + (ready.length - failed) + '장 저장했습니다' + (failed ? ' (실패 ' + failed + '장)' : '') + ' · ' + ((performance.now() - t0) / 1000).toFixed(1) + '초');
    }).catch(function (err) {
      setStatus(errText(err));
    }).then(function () { el.saveAll.disabled = false; refreshToolbar(); });
  });

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
      if (b) zip.file(uniqueName(outputName(ready[i].name, format, ready[i].part), used), b);
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
    var any = items.some(function (it) { return it.plan && !it.error; });
    el.zip.disabled = !any;
    if (el.saveAll) el.saveAll.disabled = !any;
  }

  /* 설치형 앱(PWA): Windows · macOS · Android의 Edge/Chrome에서 '앱으로 설치' */
  var installBtn = $('#install-btn'), installEvt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    installEvt = e;
    if (installBtn) installBtn.hidden = false;
  });
  if (installBtn) installBtn.addEventListener('click', function () {
    if (!installEvt) return;
    installEvt.prompt();
    installEvt.userChoice.then(function () { installEvt = null; installBtn.hidden = true; });
  });
  window.addEventListener('appinstalled', function () {
    installEvt = null;
    if (installBtn) installBtn.hidden = true;
    setStatus('설치했습니다. 시작 메뉴에서 AutoCroper를 열 수 있습니다.');
  });

  // 설치한 앱에서 탐색기 '연결 프로그램 → AutoCroper'로 연 이미지 받기
  if ('launchQueue' in window && window.launchQueue && typeof window.launchQueue.setConsumer === 'function') {
    window.launchQueue.setConsumer(function (params) {
      if (!params || !params.files || !params.files.length) return;
      Promise.all(params.files.map(function (h) { return h.getFile(); })).then(addFiles);
    });
  }

  // 데스크톱 앱: 탐색기 '연결 프로그램'으로 연 파일 받기, 웹 전용 버튼 숨기기
  if (native) {
    document.documentElement.classList.add('is-desktop');
    if (el.exeLink) el.exeLink.hidden = true;
    if (installBtn) installBtn.hidden = true;
    var tl = document.getElementById('test-link'); if (tl) tl.hidden = true; // 테스트 페이지는 설치본에 없음
    if (typeof native.onOpenFiles === 'function') {
      native.onOpenFiles(function (files) {
        addFiles((files || []).map(function (f) {
          try { return new File([f.data], f.name, { type: f.type || '' }); } catch (_) { return null; }
        }).filter(Boolean));
      });
    }
  } else if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches && el.exeLink) {
    el.exeLink.hidden = true; // 이미 설치형 웹앱으로 실행 중
  }

  /* 업데이트 안내 띠 */
  var upd = { bar: $('#update-bar'), text: $('#update-text'), btn: $('#update-btn'), close: $('#update-close'), action: null };
  function showUpdate(text, btnLabel, action) {
    upd.text.textContent = text;
    upd.btn.hidden = !btnLabel;
    upd.btn.textContent = btnLabel || '';
    upd.action = action || null;
    upd.bar.hidden = false;
  }
  upd.btn.addEventListener('click', function () { if (upd.action) upd.action(); });
  upd.close.addEventListener('click', function () { upd.bar.hidden = true; });

  // 데스크톱 앱: GitHub Releases에서 새 버전을 확인 · 내려받고, 준비되면 다시 시작해 설치
  if (native) {
    var dv = $('#desk-ver');
    if (dv) { dv.hidden = false; $('#ver-text').textContent = 'v' + (native.version || ''); }
    var manualCheck = false;
    if (typeof native.onUpdate === 'function') {
      native.onUpdate(function (st) {
        if (!st) return;
        if (st.state === 'downloading') showUpdate('새 버전' + (st.version ? ' v' + st.version : '') + ' 받는 중… ' + (st.percent != null ? Math.round(st.percent) + '%' : ''));
        else if (st.state === 'available') showUpdate('새 버전' + (st.version ? ' v' + st.version : '') + '을 받는 중입니다…');
        else if (st.state === 'downloaded') showUpdate('새 버전' + (st.version ? ' v' + st.version : '') + '이 준비됐습니다. 지금 다시 시작하거나, 앱을 닫으면 다음에 설치됩니다.', '다시 시작해 업데이트', function () { native.installUpdate(); });
        else if (st.state === 'none' && manualCheck) { setStatus('최신 버전입니다 (v' + (native.version || '') + ').'); manualCheck = false; }
        else if (st.state === 'error' && manualCheck) { setStatus('업데이트를 확인하지 못했습니다. 인터넷 연결을 확인해 주세요.'); manualCheck = false; }
      });
    }
    var cub = $('#check-update-btn');
    if (cub) cub.addEventListener('click', function () {
      if (typeof native.checkForUpdates !== 'function') return;
      manualCheck = true;
      setStatus('업데이트 확인 중…');
      native.checkForUpdates();
    });
  }

  // 웹 · 설치형 웹앱: 오프라인 캐시(서비스 워커) + 새 버전 감지
  if (!native && 'serviceWorker' in navigator && window.isSecureContext) {
    var hadController = !!navigator.serviceWorker.controller, reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController || reloading) { hadController = true; return; } // 첫 설치는 안내하지 않음
      if (!items.length) { reloading = true; location.reload(); return; } // 작업 중인 게 없으면 바로 새 버전으로
      showUpdate('새 버전이 나왔습니다. 작업을 마친 뒤 새로 고치면 적용됩니다.', '지금 새로 고침', function () { reloading = true; location.reload(); });
    });
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(function (reg) {
        var check = function () { reg.update().catch(function () {}); };
        setInterval(check, 60 * 60 * 1000); // 1시간마다
        document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') check(); });
      }).catch(function () { /* 무시 */ });
    });
  }

  // 첫 이미지가 워커 시작을 기다리지 않도록 한가할 때 미리 띄워 둔다
  (window.requestIdleCallback || function (f) { setTimeout(f, 300); })(function () { ensurePool(); });

  initSaveFolder();
  syncOptionUI();
  refreshToolbar();
})();
