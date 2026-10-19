import { FilesetResolver, PoseLandmarker } from './vendor/vision_bundle.js';
import { mapLandmarks, measure, targetBox, evaluate, mockLandmarks, HINTS } from './framing.js?v=2';

const $ = (s) => document.querySelector(s);
const video = $('#video');
const overlay = $('#overlay');
const ctx = overlay.getContext('2d');
const hintEl = $('#hint');
const hintText = $('#hintText');
const bottom = $('#bottom');
const topbar = $('#topbar');
const idle = $('#idle');
const loading = $('#loading');
const errorScreen = $('#error');
const errorMsg = $('#errorMsg');
const debugEl = $('#debug');
const lockBtn = $('#lockBtn');
const flipBtn = $('#flipBtn');
const shutter = $('#shutter');
const capture = $('#capture');
const shot = $('#shot');
const toastEl = $('#toast');
const iosWarn = $('#iosWarn');
const prep = $('#prep');
const prepText = $('#prepText');
const prepSub = $('#prepSub');
const loadText = $('#loadText');
const loadSub = $('#loadSub');

const qs = new URLSearchParams(location.search);
const MOCK = qs.has('mock');
const VARIANT = qs.get('variant') || 'ok_full';
const DEBUG = qs.has('debug');

let W = 0, H = 0, dpr = 1;
let state = 'idle';
let stream = null;
let facing = 'environment';
let mirrored = false;
let landmarker = null;
let lastPose = null;
let lastPoints = null;
let lastDetect = 0;
let lastTs = 0;
let rafId = 0;
let metrics = null;

let mode = 'full';
let manualMode = null;
let locked = false;
let detectedMode = null;
let detectedSince = 0;
let ready = false;

let hintKey = '';
let pendingKey = '';
let pendingSince = 0;
let okSince = 0;

let shotBlob = null;
let shotUrl = null;
let toastTimer = 0;

function resize() {
  const r = overlay.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width));
  const h = Math.max(1, Math.round(r.height));
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (w !== W || h !== H) resetHint();
  W = w;
  H = h;
  overlay.width = Math.round(w * dpr);
  overlay.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

function setLoad(text, sub = '') {
  loadText.textContent = text;
  loadSub.textContent = sub;
}

function setPrep(text, sub = '') {
  prepText.textContent = text;
  prepSub.textContent = sub;
}

function showError(msg) {
  state = 'error';
  idle.hidden = true;
  loading.hidden = true;
  bottom.hidden = true;
  topbar.hidden = true;
  prep.hidden = true;
  errorMsg.textContent = msg;
  errorScreen.hidden = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}

function cameraError(e) {
  if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') {
    return '相机权限被拒绝。请在 iPhone 设置 → Safari → 相机 中允许，然后刷新本页。';
  }
  if (e?.name === 'NotFoundError') return '没有找到可用的摄像头。';
  if (e?.name === 'NotReadableError') return '摄像头被其他 App 占用了，关掉相机 App 再试。';
  return '相机打不开：' + (e?.message || e);
}

async function openCamera(f) {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: f }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  });
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  mirrored = f === 'user';
  video.style.transform = mirrored ? 'scaleX(-1)' : '';
  facing = f;
  lastPose = null;
  lastPoints = null;
  lastTs = 0;
  lastDetect = 0;
  resetHint();
  await video.play().catch(() => {});
}

function withTimeout(p, ms, msg) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function wasmSimd() {
  try {
    return WebAssembly.validate(new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
      10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
    ]));
  } catch {
    return false;
  }
}

// Download with visible progress. Returns the buffer only when keep=true.
async function fetchWithProgress(url, onChunk, keep) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 300000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    if (!res.body?.getReader) {
      const buf = await res.arrayBuffer();
      onChunk(buf.byteLength, total || buf.byteLength);
      return keep ? buf : null;
    }
    const reader = res.body.getReader();
    const chunks = keep ? [] : null;
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.byteLength;
      if (chunks) chunks.push(value);
      onChunk(got, total);
    }
    if (!keep) return null;
    const out = new Uint8Array(got);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    return out.buffer;
  } finally {
    clearTimeout(timer);
  }
}

async function createLandmarker(onProgress) {
  const wasm = new URL('./vendor/wasm', import.meta.url).href;
  const modelUrl = new URL('./models/pose_landmarker_lite.task', import.meta.url).href;
  const simd = wasmSimd();
  const wasmUrl = new URL(
    `./vendor/wasm/vision_wasm_${simd ? '' : 'nosimd_'}internal.wasm`,
    import.meta.url,
  ).href;

  // Prefetch both 15 MB assets so the user sees real progress; the wasm
  // response lands in the HTTP cache and MediaPipe reuses it.
  const prog = {
    model: 0, wasm: 0,
    modelTotal: 5777746,
    wasmTotal: simd ? 9423986 : 9294247,
  };
  const report = () => onProgress?.(prog.model + prog.wasm, prog.modelTotal + prog.wasmTotal);
  let modelBuf = null;
  try {
    [modelBuf] = await Promise.all([
      fetchWithProgress(modelUrl, (n, t) => {
        prog.model = n;
        if (t) prog.modelTotal = t;
        report();
      }, true),
      fetchWithProgress(wasmUrl, (n, t) => {
        prog.wasm = n;
        if (t) prog.wasmTotal = t;
        report();
      }, false),
    ]);
  } catch (e) {
    console.warn('asset prefetch failed, using MediaPipe loader', e);
    prog.model = 0;
    prog.wasm = 0;
  }

  const fileset = await FilesetResolver.forVisionTasks(wasm);
  const base = {
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  };
  const opts = (delegate) => ({
    ...base,
    baseOptions: {
      ...(modelBuf ? { modelAssetBuffer: new Uint8Array(modelBuf) } : { modelAssetPath: modelUrl }),
      delegate,
    },
  });
  // iOS Safari can hang on the WebGL delegate; CPU is plenty for a 20 fps hint loop.
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const delegates = isIOS ? ['CPU'] : ['GPU', 'CPU'];

  let lastErr;
  for (const d of delegates) {
    try {
      return await withTimeout(
        PoseLandmarker.createFromOptions(fileset, opts(d)),
        d === 'GPU' ? 25000 : 60000,
        `取景模型初始化超时（${d}）`,
      );
    } catch (e) {
      lastErr = e;
      console.warn('landmarker delegate failed:', d, e);
    }
  }
  throw lastErr;
}

async function start() {
  idle.hidden = true;
  errorScreen.hidden = true;
  if (MOCK) {
    state = 'tracking';
    resize();
    bottom.hidden = false;
    topbar.hidden = false;
    if (DEBUG) debugEl.hidden = false;
    rafId = requestAnimationFrame(loop);
    return;
  }

  loading.hidden = false;
  state = 'loading';
  setLoad('正在打开相机…');
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(location.protocol === 'file:'
        ? '相机需要 HTTPS 或 localhost 打开。'
        : '这个浏览器不支持相机接口。');
    }
    await openCamera('environment');
  } catch (e) {
    loading.hidden = true;
    showError(cameraError(e));
    return;
  }

  // Camera is live: show the preview while the two 15 MB assets stream in.
  loading.hidden = true;
  prep.hidden = false;
  setPrep('相机已就绪，正在加载取景模型…', '首次约 15 MB');
  try {
    landmarker = await createLandmarker((done, total) => {
      const mb = (n) => (n / 1048576).toFixed(1);
      if (done >= total) setPrep('正在初始化取景模型…', '首次加载完成后会快很多');
      else setPrep('正在下载取景模型…', `${mb(done)} / ${mb(total)} MB`);
    });
  } catch (e) {
    prep.hidden = true;
    landmarker = null;
    showError('取景模型加载失败：' + (e?.message || e));
    return;
  }

  await video.play().catch(() => {});
  prep.hidden = true;
  bottom.hidden = false;
  topbar.hidden = false;
  if (DEBUG) debugEl.hidden = false;
  state = 'tracking';
  resize();

  // iOS standalone can hand back a mute black stream with no error.
  setTimeout(() => {
    if (state === 'tracking' && stream && video.readyState < 2) iosWarn.hidden = false;
  }, 2500);

  rafId = requestAnimationFrame(loop);
}

function loop(now) {
  rafId = requestAnimationFrame(loop);
  if (document.hidden) return;

  let pts = null;
  if (MOCK) {
    pts = mapLandmarks(mockLandmarks(VARIANT, W / H), { videoW: W, videoH: H, W, H });
  } else if (landmarker && video.readyState >= 2 && video.videoWidth > 0) {
    if (now - lastDetect >= 50) {
      lastDetect = now;
      const ts = Math.max(lastTs + 1, now);
      lastTs = ts;
      try {
        const res = landmarker.detectForVideo(video, ts);
        lastPose = res?.landmarks?.[0] || null;
      } catch {
        // Dropped frame; try again on the next tick.
      }
    }
    if (lastPose) {
      pts = mapLandmarks(
        lastPose,
        { videoW: video.videoWidth, videoH: video.videoHeight, W, H },
        mirrored,
      );
    }
  }

  update(pts, now);
  draw();
  if (DEBUG) updateDebug();
}

function update(pts, now) {
  lastPoints = pts;
  metrics = pts ? measure(pts) : null;

  if (!manualMode && !locked) {
    const md = metrics?.mode || null;
    if (md && md !== detectedMode) {
      detectedMode = md;
      detectedSince = now;
    }
    if (md && md !== mode) {
      const wait = MOCK ? 0 : 800;
      if (now - detectedSince >= wait) {
        mode = md;
        resetHint();
      }
    }
  }

  const box = targetBox(mode, W, H);
  const res = evaluate(metrics, box, mode, W, H, ready ? 1.2 : 1);

  if (res.key === 'ok') {
    if (!okSince) okSince = now;
    if (now - okSince >= 600) {
      ready = true;
      setHint('ok');
    } else {
      ready = false;
      setHint('hold');
    }
  } else {
    okSince = 0;
    ready = false;
    if (res.key !== pendingKey) {
      pendingKey = res.key;
      pendingSince = now;
    }
    if (now - pendingSince >= 400) setHint(res.key);
  }
  shutter.classList.toggle('ready', ready);
}

function setHint(key) {
  if (key === hintKey) return;
  hintKey = key;
  hintText.textContent = HINTS[key] || '';
  hintEl.hidden = false;
  hintEl.classList.toggle('ready', key === 'ok');
  hintEl.classList.toggle('warn', key === 'feet_cut' || key === 'head_cut' || key === 'no_full');
}

function resetHint() {
  hintKey = '';
  pendingKey = '';
  pendingSince = 0;
  okSince = 0;
  ready = false;
  shutter.classList.remove('ready');
}

function roundRect(c, x, y, w, h, r) {
  if (c.roundRect) {
    c.beginPath();
    c.roundRect(x, y, w, h, r);
    return;
  }
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function draw() {
  if (!W || !H) return;
  ctx.clearRect(0, 0, W, H);
  if (state !== 'tracking') return;

  const box = targetBox(mode, W, H);
  if (locked) {
    ctx.fillStyle = 'rgba(0,0,0,.46)';
    ctx.fillRect(0, 0, W, box.y);
    ctx.fillRect(0, box.bottom, W, H - box.bottom);
    ctx.fillRect(0, box.y, Math.max(0, box.x), box.h);
    ctx.fillRect(box.x + box.w, box.y, Math.max(0, W - box.x - box.w), box.h);
  }
  drawBox(box);
  if (DEBUG && lastPoints) drawSkeleton(lastPoints);
}

function drawBox(b) {
  const color = ready ? '#7bbf8a' : '#e9b45b';
  const r = 10;
  const L = Math.min(22, b.w * 0.18);

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = ready ? 3 : 2;
  roundRect(ctx, b.x, b.y, b.w, b.h, r);
  ctx.stroke();

  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  for (const [x, y, sx, sy] of [
    [b.x, b.y, 1, 1],
    [b.x + b.w, b.y, -1, 1],
    [b.x, b.y + b.h, 1, -1],
    [b.x + b.w, b.y + b.h, -1, -1],
  ]) {
    ctx.beginPath();
    ctx.moveTo(x + sx * L, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + sy * L);
    ctx.stroke();
  }

  const text = (mode === 'full' ? '全身' : '半身')
    + (ready ? ' · 可以拍了' : locked ? ' · 站进框里' : ' · 最佳框');
  ctx.font = '600 13px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
  ctx.textBaseline = 'middle';
  const tw = ctx.measureText(text).width;
  const lx = Math.min(Math.max(b.x, 8), W - tw - 18);
  const ly = b.y > 32 ? b.y - 12 : b.y + 26;
  ctx.fillStyle = 'rgba(12,13,14,.78)';
  roundRect(ctx, lx - 8, ly - 13, tw + 16, 24, 7);
  ctx.fill();
  ctx.fillStyle = ready ? '#c9efd2' : '#e9b45b';
  ctx.fillText(text, lx, ly - 1);
  ctx.restore();
}

function drawSkeleton(points) {
  const conns = PoseLandmarker.POSE_CONNECTIONS || [];
  ctx.save();
  ctx.strokeStyle = 'rgba(127,179,200,.7)';
  ctx.fillStyle = 'rgba(127,179,200,.9)';
  ctx.lineWidth = 1.5;
  for (const c of conns) {
    const p1 = points[c.start];
    const p2 = points[c.end];
    if (!p1?.inFrame || !p2?.inFrame) continue;
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  }
  for (const p of points) {
    if (!p.inFrame) continue;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function updateDebug() {
  const m = metrics || {};
  const vw = MOCK ? W : video.videoWidth;
  const vh = MOCK ? H : video.videoHeight;
  debugEl.textContent =
    `video ${vw}x${vh}  screen ${W}x${H}\n`
    + `mode ${mode}${manualMode ? '(manual)' : ''}  locked ${locked}  ready ${ready}\n`
    + `head ${m.headTop?.toFixed(0) ?? '-'}  height ${m.height?.toFixed(0) ?? '-'}  cx ${m.centerX?.toFixed(0) ?? '-'}\n`
    + `feet ${m.feetVisible ? 'Y' : 'N'}  hip ${m.hipsVisible ? 'Y' : 'N'}  knee ${m.kneesVisible ? 'Y' : 'N'}`;
}

function updateModeChips() {
  document.querySelectorAll('[data-mode]').forEach((b) => {
    const active = manualMode ? b.dataset.mode === manualMode : b.dataset.mode === 'auto';
    b.classList.toggle('on', active);
  });
}

async function takeShot() {
  if (MOCK) {
    showToast('模拟模式不拍照');
    return;
  }
  if (state !== 'tracking' || !video.videoWidth || !W || !H) return;

  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const outW = 1080;
  const outH = Math.round(outW * H / W);
  const scale = Math.max(outW / vw, outH / vh);
  const sw = outW / scale;
  const sh = outH / scale;
  const sx = (vw - sw) / 2;
  const sy = (vh - sh) / 2;

  const c = document.createElement('canvas');
  c.width = outW;
  c.height = outH;
  const g = c.getContext('2d');
  if (mirrored) {
    g.translate(outW, 0);
    g.scale(-1, 1);
  }
  g.drawImage(video, sx, sy, sw, sh, 0, 0, outW, outH);

  const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.92));
  if (!blob) {
    showToast('拍照失败，再试一次');
    return;
  }
  if (shotUrl) URL.revokeObjectURL(shotUrl);
  shotBlob = blob;
  shotUrl = URL.createObjectURL(blob);
  shot.src = shotUrl;
  capture.hidden = false;
  state = 'capture';
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}

async function saveShot() {
  if (!shotBlob) return;
  const file = new File([shotBlob], `aiphoto-${Date.now()}.jpg`, { type: 'image/jpeg' });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: '取景助手' });
      return;
    }
  } catch (e) {
    if (e?.name === 'AbortError') return;
  }
  const a = document.createElement('a');
  a.href = shotUrl;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  showToast('已保存到“下载”');
}

function closeCapture() {
  capture.hidden = true;
  state = 'tracking';
  if (!rafId) rafId = requestAnimationFrame(loop);
}

// --- UI wiring ---
$('#startBtn').addEventListener('click', start);
$('#retryBtn').addEventListener('click', () => {
  errorScreen.hidden = true;
  start();
});
$('#iosWarnClose').addEventListener('click', () => { iosWarn.hidden = true; });
shutter.addEventListener('click', takeShot);
$('#saveBtn').addEventListener('click', saveShot);
$('#againBtn').addEventListener('click', closeCapture);

lockBtn.addEventListener('click', () => {
  if (state !== 'tracking') return;
  locked = !locked;
  lockBtn.classList.toggle('locked', locked);
  lockBtn.textContent = locked ? '重选框' : '用这个框';
  resetHint();
});

document.querySelectorAll('[data-mode]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const v = btn.dataset.mode;
    manualMode = v === 'auto' ? null : v;
    if (v !== 'auto') mode = v;
    else detectedMode = null;
    locked = false;
    lockBtn.classList.remove('locked');
    lockBtn.textContent = '用这个框';
    resetHint();
    updateModeChips();
  });
});

flipBtn.addEventListener('click', async () => {
  if (MOCK) {
    showToast('模拟模式不切摄像头');
    return;
  }
  const next = facing === 'environment' ? 'user' : 'environment';
  try {
    await openCamera(next);
  } catch (e) {
    showToast(cameraError(e));
  }
});

window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 200));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    lastPose = null;
    lastTs = 0;
    lastDetect = 0;
    resetHint();
    if (!MOCK && stream) video.play().catch(() => {});
  }
});
window.addEventListener('pagehide', () => {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
});
window.addEventListener('pageshow', (e) => {
  if (e.persisted) location.reload();
});

resize();
if (MOCK) start();
