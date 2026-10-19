import assert from 'node:assert/strict';
import {
  mapLandmarks, measure, targetBox, evaluate, mockLandmarks, HINTS, TARGETS,
} from './framing.js';

const W = 390;
const H = 844;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

function measured(variant) {
  const lms = mockLandmarks(variant, W / H);
  // video == display, so cover mapping is the identity.
  return measure(mapLandmarks(lms, { videoW: W, videoH: H, W, H }));
}

function verdict(variant, mode) {
  const m = measured(variant);
  const md = mode || m.mode || 'full';
  return evaluate(m, targetBox(md, W, H), md, W, H);
}

// --- object-fit: cover mapping ---
{
  // Landscape stream inside a portrait screen: horizontal crop, no vertical offset.
  const out = mapLandmarks(
    [{ x: 0.5, y: 0.5, visibility: 1 }],
    { videoW: 1920, videoH: 1080, W: 390, H: 844 },
  );
  assert.ok(near(out[0].x, 195, 1e-9), `x ${out[0].x}`);
  assert.ok(near(out[0].y, 422, 1e-9), `y ${out[0].y}`);

  // Portrait stream inside the same screen: narrow horizontal crop.
  const out2 = mapLandmarks(
    [{ x: 0.5, y: 0.5, visibility: 1 }],
    { videoW: 1080, videoH: 1920, W: 390, H: 844 },
  );
  assert.ok(near(out2[0].x, 195, 1e-9), `x2 ${out2[0].x}`);
  assert.ok(near(out2[0].y, 422, 1e-9), `y2 ${out2[0].y}`);

  // Off-frame landmarks are flagged, never used as body points.
  const out3 = mapLandmarks(
    [{ x: 0.5, y: 1.2, visibility: 1 }],
    { videoW: 1080, videoH: 1920, W: 390, H: 844 },
  );
  assert.equal(out3[0].inFrame, false);

  // Front camera mirroring.
  const out4 = mapLandmarks(
    [{ x: 0.25, y: 0.5, visibility: 1 }],
    { videoW: 1920, videoH: 1080, W: 390, H: 844 },
    true,
  );
  assert.ok(near(out4[0].x, 570.111, 0.01), `mirror ${out4[0].x}`);

  // Mirrored pipeline: pre-mirrored input + mirrored mapping lands back on 0.66W.
  const lms = mockLandmarks('ok_full', W / H).map((p) => ({ ...p, x: 1 - p.x }));
  const mirrored = measure(mapLandmarks(lms, { videoW: W, videoH: H, W, H }, true));
  assert.ok(near(mirrored.centerX, 0.66 * W, 1e-6), `mirrored center ${mirrored.centerX}`);
}

// --- measurements ---
{
  const m = measured('ok_full');
  assert.equal(m.ok, true);
  assert.equal(m.mode, 'full');
  assert.ok(near(m.headTop, TARGETS.full.headroom * H, 1e-6), `headTop ${m.headTop}`);
  assert.ok(near(m.height, TARGETS.full.h * H, 1e-6), `height ${m.height}`);
  assert.ok(near(m.centerX, TARGETS.full.x * W, 1e-6), `centerX ${m.centerX}`);
}
{
  const m = measured('ok_half');
  assert.equal(m.ok, true);
  assert.equal(m.mode, 'half');
  assert.ok(near(m.headTop, TARGETS.half.headroom * H, 1e-6), `half headTop ${m.headTop}`);
  assert.ok(near(m.height, TARGETS.half.h * H, 1e-6), `half height ${m.height}`);
  assert.ok(near(m.centerX, TARGETS.half.x * W, 1e-6), `half centerX ${m.centerX}`);
}
{
  // Feet clipped at the bottom: knees in frame => full body, feet not trusted.
  const m = measured('cut');
  assert.equal(m.mode, 'full');
  assert.equal(m.feetVisible, false);
  assert.equal(m.feetCut, true);
}

// --- target boxes ---
{
  const b = targetBox('full', W, H);
  assert.ok(near(b.y, 0.36 * H));
  assert.ok(near(b.h, 0.46 * H));
  assert.ok(near(b.cx, 0.66 * W));
  assert.ok(near(b.w, Math.max(0.20 * W, 0.32 * 0.46 * H)));
  assert.ok(b.x >= 0 && b.x + b.w <= W);

  const h = targetBox('half', W, H);
  assert.ok(near(h.y, 0.24 * H));
  assert.ok(near(h.h, 0.60 * H));
  assert.ok(near(h.cx, 0.50 * W));
  assert.ok(near(h.w, 0.62 * W));
}

// --- hint selection ---
const cases = {
  ok_full: 'ok',
  ok_half: 'ok',
  close: 'too_close',
  far: 'too_far',
  cut: 'feet_cut',
  headcut: 'head_cut',
  headlow: 'head_low',
  headhigh: 'head_high',
  left: 'pan_left',
  right: 'pan_right',
  nofull: 'no_full',
  nobody: 'no_person',
};
for (const [variant, key] of Object.entries(cases)) {
  const r = verdict(variant);
  assert.equal(r.key, key, `${variant} -> ${r.key}, expected ${key}`);
  assert.equal(r.hint, HINTS[key]);
  assert.equal(r.ok, key === 'ok');
}

// Tolerance boundary: one pixel inside the size tolerance still passes.
{
  const m = measured('ok_full');
  const box = targetBox('full', W, H);
  m.height = box.h + TARGETS.full.tolH * H - 1;
  assert.equal(evaluate(m, box, 'full', W, H).key, 'ok');
  m.height = box.h + TARGETS.full.tolH * H + 1;
  assert.equal(evaluate(m, box, 'full', W, H).key, 'too_close');
}

console.log('framing: all assertions passed');
