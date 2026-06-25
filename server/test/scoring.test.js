// Unit tests for the deterministic reply-fit scoring core (server/index.js).
//
// These are pure-function tests — NO network, NO Anthropic, fully deterministic.
// They assert the *properties* the scoring plan promises (field-normalized
// saturation, "reachable ranks higher", honest 30–99 spread, goal blend, stable
// breakdown shape, NaN-safety) rather than exact magic numbers, so they survive
// reasonable tuning of the labeled priors but fail if the model regresses.
//
// Run: cd server && npm test   (node --test)

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  baselineHigh,
  FIELD_H_BASELINE,
  computeResponsiveness,
  computeReplyFitScore,
} from '../index.js';

// ─── baselineHigh / FIELD_H_BASELINE ─────────────────────────────────────────

test('baselineHigh: known field returns its FIELD_H_BASELINE value', () => {
  assert.equal(baselineHigh('Computer Science'), FIELD_H_BASELINE['Computer Science']);
  assert.equal(baselineHigh('Medicine'), FIELD_H_BASELINE['Medicine']);
  // Biomed baseline must sit above CS — the whole reason saturation is field-normed.
  assert.ok(
    FIELD_H_BASELINE['Medicine'] > FIELD_H_BASELINE['Computer Science'],
    'biomed baseline should exceed CS baseline',
  );
});

test('baselineHigh: unknown / empty field returns the default (~35)', () => {
  const def = baselineHigh('Not A Real Field');
  assert.equal(baselineHigh(''), def);
  assert.equal(baselineHigh(null), def);
  assert.equal(baselineHigh(undefined), def);
  // The plan documents the default as ~35.
  assert.ok(def >= 30 && def <= 40, `default baseline ${def} should be ~35`);
});

// ─── computeResponsiveness ───────────────────────────────────────────────────

test('computeResponsiveness: saturation is field-normalized (biomed h=50 >= CS h=50)', () => {
  const bio = computeResponsiveness({ active: true, recentWorks: 3, hIndex: 50 }, 'Medicine');
  const cs = computeResponsiveness({ active: true, recentWorks: 3, hIndex: 50 }, 'Computer Science');
  // Same raw h-index, but h=50 is field-typical in biomed and well above typical
  // in CS — so the biomed prof must NOT be penalized harder than the CS prof.
  assert.ok(
    bio.saturationScore >= cs.saturationScore,
    `biomed sat ${bio.saturationScore} should be >= CS sat ${cs.saturationScore}`,
  );
  // And the gap should be meaningful, not a rounding artifact.
  assert.ok(bio.saturationScore - cs.saturationScore > 0.1, 'field normalization should move the needle');
});

test('computeResponsiveness: a field-typical h (~baseline) is NOT heavily penalized', () => {
  // h exactly at the field baseline → fieldNormH = 1.0 → saturation ~1.0.
  const csBaseline = FIELD_H_BASELINE['Computer Science'];
  const { saturationScore } = computeResponsiveness(
    { active: true, recentWorks: 3, hIndex: csBaseline },
    'Computer Science',
  );
  assert.ok(
    saturationScore > 0.95,
    `field-typical saturation ${saturationScore} should be ~1.0 (not penalized)`,
  );
});

test('computeResponsiveness: a field-superstar (~2.5x baseline) is heavily penalized', () => {
  const csBaseline = FIELD_H_BASELINE['Computer Science'];
  const { saturationScore } = computeResponsiveness(
    { active: true, recentWorks: 3, hIndex: Math.round(csBaseline * 2.5) },
    'Computer Science',
  );
  assert.ok(saturationScore < 0.1, `superstar saturation ${saturationScore} should approach 0`);
});

test('computeResponsiveness: active + productive author scores higher activity than inactive', () => {
  const active = computeResponsiveness({ active: true, recentWorks: 6, hIndex: 30 }, 'Computer Science');
  const inactive = computeResponsiveness({ active: false, recentWorks: 0, hIndex: 30 }, 'Computer Science');
  assert.ok(
    active.activityScore > inactive.activityScore,
    `active activity ${active.activityScore} should beat inactive ${inactive.activityScore}`,
  );
  // More recent works should also help among active authors.
  const lessActive = computeResponsiveness({ active: true, recentWorks: 1, hIndex: 30 }, 'Computer Science');
  assert.ok(active.activityScore > lessActive.activityScore, 'more recent works → higher activity');
});

test('computeResponsiveness: missing stats → neutral defaults, never NaN', () => {
  const empty = computeResponsiveness({}, 'Computer Science');
  for (const k of ['resp01', 'activityScore', 'saturationScore']) {
    assert.ok(Number.isFinite(empty[k]), `${k} must be finite for empty stats`);
  }
  // Documented neutral defaults: activity 0.45 (both signals missing), saturation 0.7 (no h).
  assert.equal(empty.activityScore, 0.45);
  assert.equal(empty.saturationScore, 0.7);

  // Fully missing args must also be safe.
  const nullStats = computeResponsiveness(null, null);
  assert.ok(Number.isFinite(nullStats.resp01), 'resp01 finite for null stats');
  assert.ok(Number.isFinite(nullStats.saturationScore), 'saturation finite for null field');

  // Missing h only → saturation neutral 0.7, but activity still derived.
  const noH = computeResponsiveness({ active: true, recentWorks: 4 }, 'Computer Science');
  assert.equal(noH.saturationScore, 0.7);
  assert.ok(noH.activityScore > 0.45, 'activity still derived when only h is missing');
});

test('computeResponsiveness: resp01 stays within [0,1]', () => {
  const cases = [
    [{ active: true, recentWorks: 99, hIndex: 1 }, 'Mathematics'],
    [{ active: false, recentWorks: 0, hIndex: 9999 }, 'Medicine'],
    [{ active: true, recentWorks: -5, hIndex: -3 }, 'Computer Science'],
    [{}, undefined],
  ];
  for (const [stats, field] of cases) {
    const { resp01 } = computeResponsiveness(stats, field);
    assert.ok(resp01 >= 0 && resp01 <= 1, `resp01 ${resp01} out of [0,1] for ${JSON.stringify(stats)}`);
  }
});

// ─── computeReplyFitScore ────────────────────────────────────────────────────

// Shared topical inputs: identical fit for both professors so the ONLY difference
// is reply-likelihood (h-index drives saturation).
const TOPICAL = { bestBase: 90, hitCount: 2, n: 2, hasField: true, dominantField: 'Computer Science' };

test('computeReplyFitScore: reachable (low-h) ranks higher than a field-superstar', () => {
  const reachable = computeReplyFitScore({
    ...TOPICAL,
    stats: { active: true, recentWorks: 5, hIndex: 18 }, // low h → high saturation
  });
  const superstar = computeReplyFitScore({
    ...TOPICAL,
    stats: { active: true, recentWorks: 5, hIndex: 200 }, // huge h → low saturation
  });
  assert.ok(
    reachable.percent > superstar.percent,
    `reachable ${reachable.percent} should outrank superstar ${superstar.percent}`,
  );
});

test('computeReplyFitScore: percent is always within [30,99]', () => {
  const cases = [
    // Maximal everything.
    { bestBase: 97, hitCount: 9, n: 5, hasField: true, stats: { active: true, recentWorks: 6, hIndex: 5 }, dominantField: 'Mathematics' },
    // Minimal everything.
    { bestBase: 50, hitCount: 1, n: 1, hasField: false, stats: { active: false, recentWorks: 0, hIndex: 9999 }, dominantField: 'Medicine' },
    // Sparse / unknown.
    { bestBase: NaN, hitCount: NaN, n: NaN, hasField: false, stats: null, dominantField: null },
    // Mid.
    { ...TOPICAL, stats: { active: true, recentWorks: 3, hIndex: 40 } },
  ];
  for (const c of cases) {
    const { percent } = computeReplyFitScore(c);
    assert.ok(Number.isInteger(percent), `percent ${percent} should be an integer`);
    assert.ok(percent >= 30 && percent <= 99, `percent ${percent} out of [30,99]`);
  }
});

test('computeReplyFitScore: deterministic — same inputs → identical output', () => {
  const input = { ...TOPICAL, stats: { active: true, recentWorks: 4, hIndex: 42 }, goal: 'Research position' };
  const a = computeReplyFitScore(input);
  const b = computeReplyFitScore(input);
  const c = computeReplyFitScore(input);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

test('computeReplyFitScore: goal blend shifts weight toward FIT for conversation/shadow goals', () => {
  // Construct inputs where FIT01 is HIGH and RESP01 is LOW. Leaning toward fit
  // (0.75/0.25) must then raise the percent vs the default (0.60/0.40) blend.
  // High fit: strong base + full coverage. Low resp: inactive + field-superstar.
  const highFitLowResp = {
    bestBase: 97,
    hitCount: 6,
    n: 3,
    hasField: true,
    stats: { active: false, recentWorks: 0, hIndex: 300 }, // low activity + low saturation
    dominantField: 'Computer Science',
  };

  const defaultBlend = computeReplyFitScore({ ...highFitLowResp, goal: 'Research position' });
  const convo = computeReplyFitScore({ ...highFitLowResp, goal: 'Just a conversation' });
  const shadow = computeReplyFitScore({ ...highFitLowResp, goal: 'Shadow / observe a lab' });

  assert.ok(
    convo.percent > defaultBlend.percent,
    `"Just a conversation" (${convo.percent}) should exceed default (${defaultBlend.percent}) when fit > resp`,
  );
  assert.ok(
    shadow.percent > defaultBlend.percent,
    `"Shadow / observe" (${shadow.percent}) should exceed default (${defaultBlend.percent}) when fit > resp`,
  );

  // Symmetric sanity: when RESP is HIGH and FIT is LOW, leaning to fit should
  // LOWER the percent (confirms the lever is real, not a one-directional fluke).
  const lowFitHighResp = {
    bestBase: 55,
    hitCount: 1,
    n: 3,
    hasField: true,
    stats: { active: true, recentWorks: 6, hIndex: 12 }, // high activity + high saturation
    dominantField: 'Computer Science',
  };
  const dft2 = computeReplyFitScore({ ...lowFitHighResp, goal: 'Research position' });
  const convo2 = computeReplyFitScore({ ...lowFitHighResp, goal: 'Just a conversation' });
  assert.ok(
    convo2.percent < dft2.percent,
    `leaning to fit should lower percent (${convo2.percent}) vs default (${dft2.percent}) when resp > fit`,
  );

  // Unknown / empty goal uses the default blend.
  const unknown = computeReplyFitScore({ ...highFitLowResp, goal: 'something else entirely' });
  const noGoal = computeReplyFitScore({ ...highFitLowResp });
  assert.equal(unknown.percent, defaultBlend.percent, 'unknown goal → default blend');
  assert.equal(noGoal.percent, defaultBlend.percent, 'missing goal → default blend');
});

test('computeReplyFitScore: breakdown has the documented shape', () => {
  const { breakdown } = computeReplyFitScore({
    ...TOPICAL,
    coverage: 2,
    stats: { active: true, recentWorks: 5, hIndex: 40 },
  });
  assert.ok(breakdown && typeof breakdown === 'object', 'breakdown is an object');

  // Top-level integer fields.
  assert.ok(Number.isInteger(breakdown.fit), 'fit is an integer');
  assert.ok(Number.isInteger(breakdown.responsiveness), 'responsiveness is an integer');
  assert.ok(breakdown.fit >= 0 && breakdown.fit <= 100, 'fit in [0,100]');
  assert.ok(breakdown.responsiveness >= 0 && breakdown.responsiveness <= 100, 'responsiveness in [0,100]');

  // components.{activity,saturation} integers.
  assert.ok(breakdown.components && typeof breakdown.components === 'object', 'components is an object');
  assert.ok(Number.isInteger(breakdown.components.activity), 'activity is an integer');
  assert.ok(Number.isInteger(breakdown.components.saturation), 'saturation is an integer');

  // reasons is an array of strings.
  assert.ok(Array.isArray(breakdown.reasons), 'reasons is an array');
  for (const r of breakdown.reasons) assert.equal(typeof r, 'string', 'each reason is a string');
});

test('computeReplyFitScore: reasons never claim career stage / "early-career"', () => {
  // Exercise several stat profiles; NONE should produce a career-stage claim
  // (that signal was deliberately cut from v1 as disambiguation-noisy).
  const profiles = [
    { active: true, recentWorks: 6, hIndex: 8 },
    { active: false, recentWorks: 0, hIndex: 250 },
    { active: true, recentWorks: 2, hIndex: 40 },
    {},
  ];
  for (const stats of profiles) {
    const { breakdown } = computeReplyFitScore({ ...TOPICAL, coverage: 2, stats });
    const blob = breakdown.reasons.join(' | ').toLowerCase();
    assert.ok(!blob.includes('early-career'), `reasons must not say "early-career": ${blob}`);
    assert.ok(!blob.includes('early career'), `reasons must not say "early career": ${blob}`);
    assert.ok(!blob.includes('career stage'), `reasons must not mention career stage: ${blob}`);
    assert.ok(!blob.includes('takes students'), `reasons must not claim "takes students": ${blob}`);
  }
});

test('computeReplyFitScore: factual reasons surface coverage, activity, and busy-inbox', () => {
  // Multi-interest coverage → "Appears in N of your interests".
  const covered = computeReplyFitScore({
    ...TOPICAL,
    coverage: 3,
    stats: { active: true, recentWorks: 5, hIndex: 30 },
  });
  assert.ok(
    covered.breakdown.reasons.some((r) => /3 of your interests/.test(r)),
    'should mention interest coverage',
  );
  assert.ok(
    covered.breakdown.reasons.some((r) => /Actively publishing/.test(r)),
    'should mention active publishing',
  );

  // Inactive author → "No recent publications" reason.
  const inactive = computeReplyFitScore({
    ...TOPICAL,
    coverage: 1,
    stats: { active: false, recentWorks: 0, hIndex: 30 },
  });
  assert.ok(
    inactive.breakdown.reasons.some((r) => /No recent publications/.test(r)),
    'inactive author should get a "no recent publications" reason',
  );

  // Field-superstar (very low saturation) → "busy inbox" reason.
  const superstar = computeReplyFitScore({
    ...TOPICAL,
    coverage: 1,
    stats: { active: true, recentWorks: 5, hIndex: 300 },
  });
  assert.ok(
    superstar.breakdown.reasons.some((r) => /busy inbox/.test(r)),
    'field-superstar should get a "busy inbox" reason',
  );
});

test('computeReplyFitScore: sparse / empty inputs never throw or produce NaN', () => {
  const cases = [
    {},
    { bestBase: undefined, hitCount: undefined, n: undefined, hasField: undefined, stats: undefined, dominantField: undefined },
    { bestBase: null, hitCount: 0, n: 0, hasField: false, stats: null, dominantField: null, goal: null },
    { bestBase: NaN, hitCount: NaN, n: NaN, hasField: true, stats: { hIndex: NaN }, dominantField: 'Nope' },
  ];
  for (const c of cases) {
    const out = computeReplyFitScore(c);
    assert.ok(Number.isFinite(out.percent), `percent finite for ${JSON.stringify(c)}`);
    assert.ok(out.percent >= 30 && out.percent <= 99, `percent in range for ${JSON.stringify(c)}`);
    assert.ok(Number.isFinite(out.breakdown.fit), 'breakdown.fit finite');
    assert.ok(Number.isFinite(out.breakdown.responsiveness), 'breakdown.responsiveness finite');
    assert.ok(Number.isFinite(out.breakdown.components.activity), 'components.activity finite');
    assert.ok(Number.isFinite(out.breakdown.components.saturation), 'components.saturation finite');
  }
});
