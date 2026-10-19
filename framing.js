// Pure framing rules. No DOM, no camera, no MediaPipe — testable in Node.
// All measurement math is done in screen pixels; MediaPipe x/y are anisotropic.

export const LM = {
  NOSE: 0,
  L_EYE_INNER: 1, L_EYE: 2, L_EYE_OUTER: 3,
  R_EYE_INNER: 4, R_EYE: 5, R_EYE_OUTER: 6,
  L_EAR: 7, R_EAR: 8,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26,
  L_ANKLE: 27, R_ANKLE: 28,
  L_HEEL: 29, R_HEEL: 30,
  L_FOOT: 31, R_FOOT: 32,
};

// From learning/recipe-cards.md cards 8, 9, 11.
// h / headroom / x are fractions of frame height / width.
export const TARGETS = {
  full: { h: 0.46, headroom: 0.36, x: 0.66, tolH: 0.04, tolHead: 0.05, tolX: 0.06 },
  half: { h: 0.60, headroom: 0.24, x: 0.50, tolH: 0.05, tolHead: 0.05, tolX: 0.06, w: 0.62 },
};

export const HINTS = {
  no_person: '让 TA 站进画面',
  no_full: '退后一点，看不到全身',
  feet_cut: '退半步，脚被切了',
  head_cut: '手机往上抬一点，头被切了',
  too_close: '往后退半步',
  too_far: '往前走一步',
  head_low: '手机往下压一点',
  head_high: '手机往上抬一点',
  pan_left: '手机往左转一点',
  pan_right: '手机往右转一点',
  hold: '保持住…',
  ok: '可以拍了 · 保持住',
};

// MediaPipe normalized landmarks -> screen CSS px, matching object-fit: cover.
export function mapLandmarks(landmarks, { videoW, videoH, W, H }, mirrored = false) {
  if (!landmarks) return null;
  if (!(videoW > 0 && videoH > 0 && W > 0 && H > 0)) return null;
  const scale = Math.max(W / videoW, H / videoH);
  const dw = videoW * scale;
  const dh = videoH * scale;
  const ox = (W - dw) / 2;
  const oy = (H - dh) / 2;
  return landmarks.map((p) => {
    const u = p.x;
    const v = p.y;
    let x = ox + u * dw;
    const y = oy + v * dh;
    if (mirrored) x = W - x;
    return {
      x,
      y,
      v: p.visibility ?? 1,
      inFrame: u >= 0 && u <= 1 && v >= 0 && v <= 1,
    };
  });
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

// Screen px points -> body metrics.
export function measure(points) {
  if (!points || !points.length) return { ok: false };
  const seen = (i) => {
    const p = points[i];
    return !!p && p.inFrame && (p.v ?? 1) >= 0.5;
  };
  const p = (i) => points[i];

  const headIdx = [1, 2, 3, 4, 5, 6, 7, 8].filter(seen);
  const shouldersIdx = [11, 12].filter(seen);
  const hipsIdx = [23, 24].filter(seen);
  const kneesIdx = [25, 26].filter(seen);
  const anklesIdx = [27, 28].filter(seen);
  const feetIdx = [29, 30, 31, 32].filter(seen);

  const headVisible = headIdx.length > 0;
  const shouldersVisible = shouldersIdx.length > 0;
  const hipsVisible = hipsIdx.length > 0;
  const kneesVisible = kneesIdx.length > 0;
  const anklesVisible = anklesIdx.length > 0;
  const feetVisible = feetIdx.length > 0;

  if (!headVisible && !shouldersVisible) {
    return { ok: false, headVisible, shouldersVisible, hipsVisible, kneesVisible, anklesVisible, feetVisible };
  }

  let shoulderW = null;
  if (seen(11) && seen(12)) shoulderW = dist(p(11), p(12));
  else if (seen(7) && seen(8)) shoulderW = dist(p(7), p(8)) * 2.6;

  const shoulderY = shouldersIdx.length ? avg(shouldersIdx.map((i) => p(i).y)) : null;
  const hipY = hipsIdx.length ? avg(hipsIdx.map((i) => p(i).y)) : null;

  const headRef = headVisible ? Math.min(...headIdx.map((i) => p(i).y)) : null;
  let headTop = null;
  let approxHead = false;
  if (headRef != null) {
    // Vertical torso chain survives a turned/foreshortened body; eye+shoulder-width
    // is the fallback when hips are out of frame.
    if (shoulderY != null && hipY != null && hipY > shoulderY) {
      headTop = shoulderY - 0.60 * (hipY - shoulderY);
    } else if (shoulderW != null) {
      headTop = headRef - 0.30 * shoulderW;
    } else {
      headTop = headRef;
      approxHead = true;
    }
    headTop = Math.min(headTop, headRef);
  }

  // Full body if ankles or knees are in frame; otherwise a waist/hip crop is half body.
  let mode = null;
  if (anklesVisible || kneesVisible) mode = 'full';
  else if (hipsVisible) mode = 'half';

  let bottom = null;
  let feetCut = false;
  if (mode === 'full') {
    if (feetVisible) bottom = Math.max(...feetIdx.map((i) => p(i).y));
    else if (anklesVisible) {
      const ankleY = Math.max(...anklesIdx.map((i) => p(i).y));
      const bodyGuess = ankleY - headTop;
      bottom = ankleY + 0.06 * bodyGuess;
    } else {
      feetCut = true;
    }
  } else if (mode === 'half' && hipsVisible) {
    bottom = Math.max(...hipsIdx.map((i) => p(i).y));
  }

  const height = headTop != null && bottom != null ? bottom - headTop : null;

  const midX = [];
  if (seen(11) && seen(12)) midX.push((p(11).x + p(12).x) / 2);
  else if (shouldersVisible) midX.push(avg(shouldersIdx.map((i) => p(i).x)));
  if (seen(23) && seen(24)) midX.push((p(23).x + p(24).x) / 2);
  else if (hipsVisible) midX.push(avg(hipsIdx.map((i) => p(i).x)));
  const centerX = midX.length ? avg(midX) : null;

  return {
    ok: headTop != null && centerX != null,
    mode,
    headTop,
    bottom,
    height,
    centerX,
    shoulderW,
    approxHead,
    headVisible,
    shouldersVisible,
    hipsVisible,
    kneesVisible,
    anklesVisible,
    feetVisible,
    feetCut,
  };
}

export function targetBox(mode, W, H) {
  const t = TARGETS[mode] || TARGETS.full;
  const h = t.h * H;
  const w = mode === 'half' ? t.w * W : Math.max(0.20 * W, 0.32 * h);
  const cx = t.x * W;
  const y = t.headroom * H;
  return { x: cx - w / 2, y, w, h, cx, bottom: y + h };
}

// Compare current body against the target box. One hint at a time.
export function evaluate(m, box, mode, W, H) {
  const out = (key, ok = false, errors = {}) => ({ ok, key, hint: HINTS[key], errors });

  if (!m || !m.ok) return out('no_person');
  if (!m.headVisible && !m.shouldersVisible) return out('no_person');
  // Too close to see hips/knees/ankles: neither full nor half can be judged.
  if (!m.hipsVisible && !m.kneesVisible && !m.anklesVisible) return out('no_full');

  const t = TARGETS[mode] || TARGETS.full;

  if (mode === 'full' && m.feetCut) return out('feet_cut');
  if (!m.headVisible || m.headTop < 0.15 * H) return out('head_cut');
  if (m.height == null) return out('no_full');

  const errors = {
    height: m.height - box.h,
    head: m.headTop - box.y,
    x: m.centerX - box.cx,
  };

  if (errors.height > t.tolH * H) return out('too_close', false, errors);
  if (errors.height < -t.tolH * H) return out('too_far', false, errors);
  if (errors.head > t.tolHead * H) return out('head_low', false, errors);
  if (errors.head < -t.tolHead * H) return out('head_high', false, errors);
  if (errors.x < -t.tolX * W) return out('pan_left', false, errors);
  if (errors.x > t.tolX * W) return out('pan_right', false, errors);
  return out('ok', true, errors);
}

// Synthetic 33-point pose for ?mock=1 and unit tests.
// ht/height are fractions of frame height; cx is a fraction of frame width.
const MOCKS = {
  ok_full:  { ht: 0.36, hn: 0.46, cx: 0.66, vis: 'full' },
  ok_half:  { ht: 0.24, hn: 1.25, cx: 0.50, vis: 'half' },
  close:    { ht: 0.30, hn: 0.62, cx: 0.66, vis: 'full' },
  far:      { ht: 0.42, hn: 0.34, cx: 0.66, vis: 'full' },
  cut:      { ht: 0.28, hn: 0.85, cx: 0.66, vis: 'full' },
  headcut:  { ht: -0.02, hn: 0.60, cx: 0.66, vis: 'full' },
  headlow:  { ht: 0.46, hn: 0.43, cx: 0.66, vis: 'full' },
  headhigh: { ht: 0.26, hn: 0.46, cx: 0.66, vis: 'full' },
  left:     { ht: 0.36, hn: 0.46, cx: 0.40, vis: 'full' },
  right:    { ht: 0.36, hn: 0.46, cx: 0.86, vis: 'full' },
  nofull:   { ht: 0.20, hn: 1.80, cx: 0.50, vis: 'torso' },
  nobody:   { ht: 0.20, hn: 0.50, cx: 0.50, vis: 'none' },
};

export function mockLandmarks(variant, aspect) {
  const V = MOCKS[variant] || MOCKS.ok_full;
  const P = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.02 }));
  const xw = (len) => len / aspect; // length as fraction of H -> normalized x
  const set = (i, x, y) => { P[i] = { x, y, visibility: 1 }; };

  const { ht, hn, cx } = V;
  const half = xw(0.24 * hn / 2);
  const shY = ht + 0.18 * hn;
  const hipY = ht + 0.48 * hn;
  const kneeY = ht + 0.72 * hn;
  const ankleY = ht + 0.94 * hn;
  const footY = ht + hn;
  const eyeY = ht + 0.072 * hn;

  set(0, cx, ht + 0.08 * hn);
  set(1, cx - xw(0.02 * hn), eyeY);
  set(2, cx - xw(0.03 * hn), eyeY);
  set(3, cx - xw(0.04 * hn), eyeY);
  set(4, cx + xw(0.02 * hn), eyeY);
  set(5, cx + xw(0.03 * hn), eyeY);
  set(6, cx + xw(0.04 * hn), eyeY);
  set(7, cx - xw(0.06 * hn), eyeY);
  set(8, cx + xw(0.06 * hn), eyeY);

  set(11, cx - half, shY);
  set(12, cx + half, shY);
  set(13, cx - half * 1.2, shY + 0.12 * hn);
  set(14, cx + half * 1.2, shY + 0.12 * hn);
  set(15, cx - half * 1.1, shY + 0.24 * hn);
  set(16, cx + half * 1.1, shY + 0.24 * hn);
  set(23, cx - half * 0.7, hipY);
  set(24, cx + half * 0.7, hipY);
  set(25, cx - half * 0.55, kneeY);
  set(26, cx + half * 0.55, kneeY);
  set(27, cx - half * 0.55, ankleY);
  set(28, cx + half * 0.55, ankleY);
  set(29, cx - half * 0.55, footY);
  set(30, cx + half * 0.55, footY);
  set(31, cx - half * 0.50, footY);
  set(32, cx + half * 0.50, footY);

  if (V.vis === 'half') {
    for (const i of [25, 26, 27, 28, 29, 30, 31, 32]) {
      P[i].visibility = 0.02;
      P[i].y = Math.max(P[i].y, 1.05);
    }
  } else if (V.vis === 'torso') {
    for (const i of [23, 24, 25, 26, 27, 28, 29, 30, 31, 32]) {
      P[i].visibility = 0.02;
      P[i].y = Math.max(P[i].y, 1.05);
    }
  } else if (V.vis === 'none') {
    P.forEach((q) => { q.visibility = 0.02; });
  }
  return P;
}
