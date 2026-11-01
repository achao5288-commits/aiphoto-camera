import { FilesetResolver, PoseLandmarker } from './vendor/vision_bundle.js';
import {
  mapLandmarks, measure, targetBox, followBox, evaluate, mockLandmarks, HINTS,
  announceAllowed, levelHint, LEVEL_TOL,
} from './framing.js?v=5';

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
const voiceBtn = $('#voiceBtn');
const shutter = $('#shutter');
const capture = $('#capture');
const shot = $('#shot');
const toastEl = $('#toast');
const iosWarn = $('#iosWarn');
const prep = $('#prep');
const prepRetry = $('#prepRetry');
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

let scene = 'portrait';
let roll = null;
let motionOn = false;
let lockedCx = null;

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

// Offer an escape hatch once loading looks stuck, rather than leaving the user
// staring at a frozen progress line.
let prepTimer = 0;
function watchPrep() {
  clearTimeout(prepTimer);
  prepRetry.hidden = true;
  prepTimer = setTimeout(() => {
    if (state === 'loading') prepRetry.hidden = false;
  }, 45000);
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

// A silent connection is worse than a slow one: give up on a range quickly so
// the retry/mirror path can take over instead of hanging the loading screen.
const STALL_MS = 20000;

// Download in 1 MiB ranges with per-chunk retries. GitHub Pages edges in
// mainland China reset long transfers; short ranges survive and resume.
async function fetchRange(url, start, end, retries = 2) {
  let delay = 400;
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), STALL_MS);
    try {
      const res = await fetch(url, {
        headers: { Range: `bytes=${start}-${end}` },
        signal: ctrl.signal,
      });
      if (res.status === 200 || res.status === 404 || res.status === 416) {
        ctrl.abort();
        const err = new Error(`HTTP ${res.status}`);
        err.noRetry = true;
        throw err;
      }
      if (res.status !== 206) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const want = end - start + 1;
      if (buf.byteLength !== want) throw new Error(`short read ${buf.byteLength}/${want}`);
      return new Uint8Array(buf);
    } catch (e) {
      // A dead connection will not come back in 400 ms; hand the asset to the
      // next mirror host instead of burning three timeouts on this one.
      if (ctrl.signal.aborted) {
        const t = new Error('连接超时');
        t.noRetry = true;
        throw t;
      }
      if (e.noRetry || attempt >= retries) throw e;
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function downloadChunked(url, size, onProgress) {
  const CHUNK = 256 << 10;
  const CONC = 4;
  const out = new Uint8Array(size);
  const ranges = [];
  for (let s = 0; s < size; s += CHUNK) {
    ranges.push([s, Math.min(s + CHUNK - 1, size - 1)]);
  }
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < ranges.length) {
      const [s, e] = ranges[next++];
      const bytes = await fetchRange(url, s, e);
      out.set(bytes, s);
      done += bytes.byteLength;
      onProgress?.(done, size);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONC, ranges.length) }, worker));
  return out;
}

async function readBody(res, onProgress) {
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body?.getReader) {
    const buf = await res.arrayBuffer();
    onProgress?.(buf.byteLength, buf.byteLength);
    return new Uint8Array(buf);
  }
  const reader = res.body.getReader();
  const out = total ? new Uint8Array(total) : null;
  const chunks = out ? null : [];
  let got = 0;
  for (;;) {
    let idle = 0;
    let step;
    try {
      step = await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          idle = setTimeout(() => reject(new Error('下载卡住')), STALL_MS);
        }),
      ]);
    } catch (e) {
      reader.cancel().catch(() => {});
      throw e;
    } finally {
      clearTimeout(idle);
    }
    const { done, value } = step;
    if (done) break;
    if (out) out.set(value, got);
    else chunks.push(value);
    got += value.byteLength;
    onProgress?.(got, total || got);
  }
  if (out) return out.subarray(0, got);
  const joined = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) {
    joined.set(c, off);
    off += c.byteLength;
  }
  return joined;
}

// One-byte Range probe: chunked when supported (resumable on flaky mobile
// networks), otherwise read the full response the probe already opened.
async function downloadAsset(url, size, onProgress) {
  // The probe is one byte: if that cannot land in 8 s, the host is not for us.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  let probe;
  try {
    probe = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
  if (probe.status === 206) {
    await probe.arrayBuffer();
    return downloadChunked(url, size, onProgress);
  }
  if (probe.status === 200) return readBody(probe, onProgress);
  throw new Error(`HTTP ${probe.status}`);
}

// What the network is doing, for the loading screen to report.
const net = { retries: 0, err: '' };

async function downloadAny(urls, size, onProgress) {
  let last;
  for (const url of urls) {
    try {
      return await downloadAsset(url, size, onProgress);
    } catch (e) {
      last = e;
      net.err = String(e?.message || e).slice(0, 40);
      net.retries += 1;
      console.warn('download failed:', url, e);
    }
  }
  throw last;
}

// Keep the 14.5 MB of model + wasm on the device so the second visit costs no
// network at all. iOS may evict site data after a week without a visit.
const ASSET_CACHE = 'aiphoto-assets-v1';

async function cacheGet(url) {
  if (!('caches' in window)) return null;
  try {
    const res = await (await caches.open(ASSET_CACHE)).match(url);
    if (!res) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.byteLength ? buf : null;
  } catch {
    return null;
  }
}

async function cachePut(url, bytes) {
  if (!('caches' in window)) return;
  try {
    const c = await caches.open(ASSET_CACHE);
    await c.put(url, new Response(bytes));
  } catch {}
}

async function createLandmarker(onProgress) {
  const wasm = new URL('./vendor/wasm', import.meta.url).href;
  const modelUrl = new URL('./models/pose_landmarker_lite.task', import.meta.url).href;
  const simd = wasmSimd();
  const wasmName = `vision_wasm_${simd ? '' : 'nosimd_'}internal.wasm`;
  const wasmUrl = new URL(`./vendor/wasm/${wasmName}`, import.meta.url).href;
  // GitHub Pages first, then the three jsDelivr edges: on mainland cellular the
  // first host is the one that stalls.
  const CDN = ['https://cdn.jsdelivr.net', 'https://fastly.jsdelivr.net', 'https://gcore.jsdelivr.net'];
  const modelMirrors = CDN.map((h) => `${h}/gh/achao5288-commits/aiphoto-camera@main/models/pose_landmarker_lite.task`);
  const wasmMirrors = CDN.map((h) => `${h}/npm/@mediapipe/tasks-vision@0.10.14/wasm/${wasmName}`);
  const modelMirror = modelMirrors[0];
  const wasmMirror = wasmMirrors[0];

  const prog = {
    model: 0, wasm: 0,
    modelTotal: 5777746,
    wasmTotal: simd ? 9423986 : 9294247,
  };
  const report = () => onProgress?.(prog.model + prog.wasm, prog.modelTotal + prog.wasmTotal);

  let modelBuf = await cacheGet(modelUrl);
  let wasmBuf = await cacheGet(wasmUrl);
  if (modelBuf) prog.model = prog.modelTotal;
  if (wasmBuf) prog.wasm = prog.wasmTotal;
  const fromCache = !!(modelBuf && wasmBuf);

  const [mb, wb] = await Promise.allSettled([
    modelBuf ? Promise.resolve(modelBuf) : downloadAny([modelUrl, ...modelMirrors], prog.modelTotal, (n, t) => {
      prog.model = Math.max(prog.model, n);
      prog.modelTotal = t;
      report();
    }),
    wasmBuf ? Promise.resolve(wasmBuf) : downloadAny([wasmUrl, ...wasmMirrors], prog.wasmTotal, (n, t) => {
      prog.wasm = Math.max(prog.wasm, n);
      prog.wasmTotal = t;
      report();
    }),
  ]);
  if (mb.status === 'fulfilled') {
    if (!modelBuf) {
      modelBuf = mb.value;
      cachePut(modelUrl, modelBuf);
    }
  } else {
    console.warn('model prefetch failed', mb.reason);
  }
  if (wb.status === 'fulfilled') {
    if (!wasmBuf) {
      wasmBuf = wb.value;
      cachePut(wasmUrl, wasmBuf);
    }
  } else {
    console.warn('wasm prefetch failed', wb.reason);
  }
  const wasmBlobUrl = wasmBuf
    ? URL.createObjectURL(new Blob([wasmBuf], { type: 'application/wasm' }))
    : null;

  // Prefetch is done (or skipped); MediaPipe now compiles from memory/cache.
  onProgress?.(prog.modelTotal + prog.wasmTotal, prog.modelTotal + prog.wasmTotal);
  if (fromCache) setPrep('正在初始化取景模型…', '已缓存，不耗流量');
  else if (!modelBuf || !wasmBlobUrl) {
    setPrep('下载不完整，正在换备用线路…', '最多再等 60 秒，也可以直接重试');
  }

  const fileset = await FilesetResolver.forVisionTasks(wasm);
  fileset.wasmBinaryPath = wasmBlobUrl || wasmMirror;
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
      ...(modelBuf ? { modelAssetBuffer: modelBuf } : { modelAssetPath: modelMirror }),
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
  unlockSpeech();
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
  watchPrep();
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
  let moved = performance.now();
  let lastMb = 0;
  const stallTimer = setInterval(() => {
    if (performance.now() - moved < 20000) return;
    if (lastMb > 0) {
      setPrep('网络卡住了，正在重试…', `已下载 ${lastMb.toFixed(1)} MB`
        + (net.retries ? ` · 重试 ${net.retries} 次` : ''));
    } else {
      setPrep('正在换线路…', net.err
        ? `${net.err} · 已试 ${net.retries} 条线路`
        : '连接不动了');
    }
  }, 2000);
  try {
    landmarker = await createLandmarker((done, total) => {
      const mb = (n) => (n / 1048576).toFixed(1);
      moved = performance.now();
      lastMb = done / 1048576;
      if (done >= total) {
        clearInterval(stallTimer);
        setPrep('正在初始化取景模型…', '首次加载完成后会快很多');
      } else {
        setPrep('正在下载取景模型…', `${mb(done)} / ${mb(total)} MB`);
      }
    });
  } catch (e) {
    prep.hidden = true;
    landmarker = null;
    showError('取景模型加载失败：' + (e?.message || e)
      + '。首次需要下载约 15 MB，请检查网络后重试，或换 Wi-Fi。');
    return;
  } finally {
    clearInterval(stallTimer);
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
  if (scene === 'landscape') {
    // Nothing to detect: a landscape frame is judged by the phone's level.
  } else if (MOCK) {
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
  if (scene === 'landscape') {
    lastPoints = null;
    metrics = null;
    commitHint(levelHint(roll), now);
    return;
  }

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
  commitHint(evaluate(metrics, box, mode, W, H, ready ? 1.2 : 1).key, now);
}

// Hold a good state briefly so a green frame does not flicker, and debounce
// every other hint the same way.
function commitHint(key, now) {
  if (key === 'ok') {
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
    if (key !== pendingKey) {
      pendingKey = key;
      pendingSince = now;
    }
    if (now - pendingSince >= 400) setHint(key);
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
  speak(key);
  buzz(key);
}

// --- 语音 / 震动：眼睛看着人，不看屏幕 ---
let voiceOn = (() => {
  try { return localStorage.getItem('aiphoto.voice') !== '0'; } catch { return true; }
})();
let voiceUnlocked = false;
const spokenAt = Object.create(null);
let lastSpoke = -Infinity;

// iOS only starts speech from a user gesture; a silent utterance in the tap
// handler opens the audio session for every later hint.
function unlockSpeech() {
  if (voiceUnlocked || !('speechSynthesis' in window)) return;
  voiceUnlocked = true;
  say(' ');
}

function say(text) {
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = 1.05;
    speechSynthesis.speak(u);
  } catch {}
}

function speak(key) {
  if (!voiceOn || !voiceUnlocked || !('speechSynthesis' in window)) return;
  const now = performance.now();
  if (!announceAllowed(key, now, spokenAt, lastSpoke)) return;
  spokenAt[key] = now;
  lastSpoke = now;
  say(key === 'ok' ? '可以拍了，保持住' : HINTS[key]);
}

// Chrome only allows vibrate after sticky user activation; calling it earlier
// just fills the console with blocked-call errors.
let userActive = false;
for (const ev of ['pointerdown', 'keydown']) {
  window.addEventListener(ev, () => { userActive = true; }, { once: true, capture: true });
}

function buzz(key) {
  if (!userActive || !navigator.vibrate) return;
  navigator.vibrate(key === 'ok' ? [40, 70, 40] : 25);
}

function setVoice(on) {
  voiceOn = on;
  voiceBtn.classList.toggle('on', on);
  voiceBtn.setAttribute('aria-pressed', String(on));
  try { localStorage.setItem('aiphoto.voice', on ? '1' : '0'); } catch {}
  if (!on) { try { speechSynthesis.cancel(); } catch {} }
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

  if (scene === 'landscape') {
    drawLevel();
    return;
  }

  const box = followBox(mode, W, H, locked ? lockedCx : metrics?.centerX);
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

// Landscape: nobody to track, so show thirds plus a gravity-driven level.
function drawLevel() {
  const ok = roll != null && Math.abs(roll) <= LEVEL_TOL;
  const color = roll == null ? 'rgba(255,255,255,.4)' : ok ? '#7bbf8a' : '#e9b45b';

  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,.16)';
  ctx.lineWidth = 1;
  for (const f of [1 / 3, 2 / 3]) {
    ctx.beginPath(); ctx.moveTo(W * f, 0); ctx.lineTo(W * f, H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, H * f); ctx.lineTo(W, H * f); ctx.stroke();
  }

  const cy = H * 0.5;
  const half = Math.min(W * 0.36, 160);
  ctx.strokeStyle = color;
  ctx.lineWidth = ok ? 3 : 2;
  ctx.lineCap = 'round';
  if (roll == null) ctx.setLineDash([7, 7]);
  ctx.beginPath();
  ctx.moveTo(W / 2 - half, cy);
  ctx.lineTo(W / 2 + half, cy);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(W / 2, cy - 14);
  ctx.lineTo(W / 2, cy + 14);
  ctx.stroke();

  const text = roll == null ? '无姿态数据'
    : ok ? '水平' : `${roll < 0 ? '右低' : '左低'} ${Math.abs(roll).toFixed(1)}°`;
  ctx.font = '600 13px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
  ctx.textBaseline = 'middle';
  const tw = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(12,13,14,.78)';
  roundRect(ctx, W / 2 - tw / 2 - 8, cy + 18, tw + 16, 24, 7);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillText(text, W / 2 - tw / 2, cy + 30);
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
    + `scene ${scene}  roll ${roll == null ? '-' : roll.toFixed(1)}°\n`
    + `mode ${mode}${manualMode ? '(manual)' : ''}  locked ${locked}  ready ${ready}\n`
    + `head ${m.headTop?.toFixed(0) ?? '-'}  height ${m.height?.toFixed(0) ?? '-'}  cx ${m.centerX?.toFixed(0) ?? '-'}\n`
    + `feet ${m.feetVisible ? 'Y' : 'N'}  hip ${m.hipsVisible ? 'Y' : 'N'}  knee ${m.kneesVisible ? 'Y' : 'N'}`;
}

// --- 场景：人像看关键点，风景看重力水平仪 ---
function onMotion(e) {
  const g = e.accelerationIncludingGravity;
  if (!g || g.x == null) return;
  const x = g.x || 0;
  const y = g.y || 0;
  // Phone lying flat: gravity leaves the screen plane and roll means nothing.
  roll = Math.abs(y) < 3 ? null : Math.atan2(-x, -y) * 180 / Math.PI;
}

async function enableMotion() {
  if (motionOn) return;
  const DME = window.DeviceMotionEvent;
  try {
    if (DME && typeof DME.requestPermission === 'function') {
      if (await DME.requestPermission() !== 'granted') return;
    }
    window.addEventListener('devicemotion', onMotion);
    motionOn = true;
  } catch {}
}

const sceneBtns = document.querySelectorAll('[data-scene]');
const portraitModes = $('#portraitModes');

function updateSceneChips() {
  sceneBtns.forEach((b) => b.classList.toggle('on', b.dataset.scene === scene));
  portraitModes.hidden = scene !== 'portrait';
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
prepRetry.addEventListener('click', () => location.reload());
shutter.addEventListener('click', takeShot);
$('#saveBtn').addEventListener('click', saveShot);
$('#againBtn').addEventListener('click', closeCapture);

lockBtn.addEventListener('click', () => {
  if (state !== 'tracking') return;
  locked = !locked;
  lockedCx = locked ? (metrics?.centerX ?? null) : null;
  lockBtn.classList.toggle('locked', locked);
  lockBtn.textContent = locked ? '重选框' : '用这个框';
  resetHint();
});

sceneBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.scene === scene) return;
    scene = btn.dataset.scene;
    locked = false;
    lockedCx = null;
    lockBtn.classList.remove('locked');
    lockBtn.textContent = '用这个框';
    lastPose = null;
    lastPoints = null;
    metrics = null;
    roll = null;
    lockBtn.hidden = scene === 'landscape';
    resetHint();
    updateSceneChips();
    if (scene === 'landscape') enableMotion();
  });
});

document.querySelectorAll('[data-mode]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const v = btn.dataset.mode;
    manualMode = v === 'auto' ? null : v;
    if (v !== 'auto') mode = v;
    else detectedMode = null;
    locked = false;
    lockedCx = null;
    lockBtn.classList.remove('locked');
    lockBtn.textContent = '用这个框';
    resetHint();
    updateModeChips();
  });
});

voiceBtn.addEventListener('click', () => {
  unlockSpeech();
  setVoice(!voiceOn);
  if (voiceOn) say('语音已开启');
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
  if (document.hidden) {
    try { speechSynthesis.cancel(); } catch {}
    return;
  }
  lastPose = null;
  lastTs = 0;
  lastDetect = 0;
  resetHint();
  if (!MOCK && stream) video.play().catch(() => {});
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
setVoice(voiceOn);
updateSceneChips();
if (MOCK) start();
