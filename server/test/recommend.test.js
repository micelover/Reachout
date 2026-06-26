// Contract tests for POST /api/recommend (the profile-driven reply-fit endpoint).
//
// Mirrors the harness in routes.test.js: supertest drives the Express app in
// process (so the test client never touches global.fetch), and every OpenAlex
// call is mocked via a URL-matching fetch stub. Fully offline, deterministic, no
// Anthropic tokens. Run: cd server && npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app, cache } from '../index.js';

const realFetch = global.fetch;

beforeEach(() => {
  cache.clear(); // oaFetch memoizes by URL — start every case clean
});

afterEach(() => {
  global.fetch = realFetch;
});

// URL-matching fetch stub (same shape as routes.test.js mockFetch).
function mockFetch(routes) {
  global.fetch = async (url) => {
    const u = String(url);
    const r = routes.find((x) => x.match(u));
    if (!r) {
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    }
    return {
      ok: r.ok !== undefined ? r.ok : true,
      status: r.status || 200,
      headers: { get: () => 'application/json' },
      json: async () => r.json ?? {},
      text: async () => r.text ?? '',
    };
  };
}

// ── Canned OpenAlex payloads for the happy path ──────────────────────────────
// pickDominantField + discoverByField hit /topics first (field → topic id + field
// id), then /authors. We pin the topic to T999 / fields/17 and give every author
// that exact topic at index 0 so they survive discoverByField's top-5 precision
// filter. The superstar is MORE cited (so OpenAlex's cited_by_count sort would put
// it first) — letting us assert that reply-fit reorders to favor the reachable one.
const TOPIC_FULL = 'https://openalex.org/T999';
const FIELD_FULL = 'https://openalex.org/fields/17';
const SUBFIELD_FULL = 'https://openalex.org/subfields/1702';
const yr = new Date().getFullYear();

const topicsJson = {
  results: [
    {
      id: TOPIC_FULL,
      display_name: 'Machine Learning',
      field: { id: FIELD_FULL, display_name: 'Computer Science' },
      subfield: { id: SUBFIELD_FULL, display_name: 'Artificial Intelligence' },
    },
  ],
};

const mkTopic = (count) => ({
  id: TOPIC_FULL,
  display_name: 'Machine Learning',
  count,
  field: { id: FIELD_FULL, display_name: 'Computer Science' },
  subfield: { id: SUBFIELD_FULL, display_name: 'Artificial Intelligence' },
});

const authorsJson = {
  meta: { count: 2 },
  results: [
    {
      id: 'https://openalex.org/A2000',
      display_name: 'Dr. Famous Superstar',
      works_count: 800,
      cited_by_count: 500000,
      last_known_institutions: [
        { id: 'https://openalex.org/I1', display_name: 'Big U', country_code: 'US', type: 'education' },
      ],
      topics: [mkTopic(400)],
      summary_stats: { h_index: 220, i10_index: 600 },
      counts_by_year: [
        { year: yr, works_count: 30 },
        { year: yr - 1, works_count: 30 },
      ],
    },
    {
      id: 'https://openalex.org/A1000',
      display_name: 'Dr. Reachable Riser',
      works_count: 40,
      cited_by_count: 1200,
      last_known_institutions: [
        { id: 'https://openalex.org/I2', display_name: 'State College', country_code: 'US', type: 'education' },
      ],
      topics: [mkTopic(25)],
      summary_stats: { h_index: 14, i10_index: 18 },
      counts_by_year: [
        { year: yr, works_count: 6 },
        { year: yr - 1, works_count: 5 },
      ],
    },
  ],
};

function mockOpenAlexHappyPath() {
  mockFetch([
    { match: (u) => u.includes('/topics') || u.includes('/autocomplete/topics'), json: topicsJson },
    { match: (u) => u.includes('/authors'), json: authorsJson },
  ]);
}

// ── Validation path (no upstream call) ───────────────────────────────────────

test('POST /api/recommend: empty body {} → 400 { error } (no OpenAlex call)', async () => {
  // Trip-wire: the validation path must short-circuit before any fetch.
  let fetched = false;
  global.fetch = async (...a) => { fetched = true; return realFetch(...a); };

  const res = await request(app).post('/api/recommend').send({});
  assert.equal(res.status, 400);
  assert.ok(typeof res.body.error === 'string', 'body should be { error: string }');
  assert.equal(fetched, false, 'no OpenAlex/fetch on the 400 validation path');
});

test('POST /api/recommend: only-blank interests + blank field → 400', async () => {
  // After trim/filter, nothing usable AND no field → same validation 400.
  const res = await request(app)
    .post('/api/recommend')
    .send({ interests: ['', '   ', null], field: '   ' });
  assert.equal(res.status, 400);
  assert.ok(typeof res.body.error === 'string');
});

// ── Happy path with stubbed OpenAlex fan-out ─────────────────────────────────

test('POST /api/recommend: returns scored professors[] each with matchScore ∈[30,99] + breakdown', async () => {
  mockOpenAlexHappyPath();
  const res = await request(app)
    .post('/api/recommend')
    .send({ interests: ['machine learning'], field: 'Computer Science', goal: 'Research position' });

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.professors), 'professors should be an array');
  assert.ok(res.body.professors.length >= 2, 'both stubbed authors survive the precision filter');

  for (const p of res.body.professors) {
    assert.ok(Number.isInteger(p.matchScore), 'integer matchScore');
    assert.ok(p.matchScore >= 30 && p.matchScore <= 99, `matchScore ${p.matchScore} in [30,99]`);
    assert.ok(p.breakdown && typeof p.breakdown === 'object', 'carries a breakdown');
    assert.ok(Number.isInteger(p.breakdown.fit), 'breakdown.fit int');
    assert.ok(Number.isInteger(p.breakdown.responsiveness), 'breakdown.responsiveness int');
    assert.ok(p.breakdown.components, 'breakdown.components present');
    assert.ok(Array.isArray(p.breakdown.reasons), 'breakdown.reasons array');
    // Internal scoring inputs must NOT leak into the public card DTO.
    assert.equal(p.stats, undefined, 'internal stats stripped from the card');
    assert.equal(p.dominantField, undefined, 'internal dominantField stripped from the card');
  }
});

test('POST /api/recommend: reply-fit reorders — reachable low-h beats the more-cited superstar', async () => {
  mockOpenAlexHappyPath();
  const res = await request(app)
    .post('/api/recommend')
    .send({ interests: ['machine learning'], field: 'Computer Science' });

  assert.equal(res.status, 200);
  const riser = res.body.professors.find((p) => p.name === 'Dr. Reachable Riser');
  const superstar = res.body.professors.find((p) => p.name === 'Dr. Famous Superstar');
  assert.ok(riser && superstar, 'both professors present');
  assert.ok(
    riser.matchScore > superstar.matchScore,
    `reachable ${riser.matchScore} should outrank superstar ${superstar.matchScore}`,
  );
  // professors[] sorted by matchScore desc.
  const scores = res.body.professors.map((p) => p.matchScore);
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i - 1] >= scores[i], 'sorted by matchScore desc');
  }
});

test('POST /api/recommend: garbage unis + out-of-range limit are sanitized (200, no crash)', async () => {
  mockOpenAlexHappyPath();
  const res = await request(app)
    .post('/api/recommend')
    .send({
      interests: ['machine learning'],
      field: 'Computer Science',
      unis: ['not-an-id', 'I123 OR 1=1', 42, null, 'I7'], // only "I7" survives the /^I\d+$/ filter
      limit: 9999, // clamped to 150
    });
  assert.equal(res.status, 200, 'bad unis / oversized limit are sanitized, not fatal');
  assert.ok(Array.isArray(res.body.professors), 'still returns a professors array');
});

// ── Upstream failure → honest 502 on a TOTAL outage ─────────────────────────

test('POST /api/recommend: a total OpenAlex outage (every bucket fails) returns 502, not a misleading empty list', async () => {
  // Contract: the plan calls for 502 on OpenAlex failure. The shared engine wraps
  // each per-bucket discoverByField in `.catch(() => null)` so PARTIAL failures
  // degrade gracefully (surviving buckets still rank). But when EVERY bucket
  // errors, returning 200 + [] would falsely read as "no professors match your
  // profile" when the truth is the upstream is down — so recommendForInterests
  // detects the all-null case and throws a 502-tagged error the route surfaces.
  global.fetch = async () => { throw new Error('network down'); };
  const res = await request(app)
    .post('/api/recommend')
    .send({ interests: ['machine learning'], field: 'Computer Science' });

  assert.equal(res.status, 502, 'a total OpenAlex outage is an honest 502, not a 200');
  assert.ok(res.body.error, '502 carries an { error } message for the UI to surface');
});

// ── excludeIds: drop already-contacted professors, then top the list back up ──

test('POST /api/recommend: excludeIds drops a professor and tops the list back up from the pool', async () => {
  mockOpenAlexHappyPath();
  // Baseline at limit:1 → the single top-ranked survivor (the reachable riser).
  const base = await request(app)
    .post('/api/recommend')
    .send({ interests: ['machine learning'], field: 'Computer Science', limit: 1 });
  assert.equal(base.status, 200);
  assert.equal(base.body.professors.length, 1, 'baseline returns exactly one professor');
  const topId = base.body.professors[0].id;

  // Excluding that professor must REFILL the slot from the pool (the other author),
  // not collapse the list to empty — this is the "stays full" guarantee.
  const res = await request(app)
    .post('/api/recommend')
    .send({ interests: ['machine learning'], field: 'Computer Science', limit: 1, excludeIds: [topId] });
  assert.equal(res.status, 200);
  assert.equal(res.body.professors.length, 1, 'count topped up from the pool, not just filtered down');
  assert.ok(!res.body.professors.some((p) => p.id === topId), 'the excluded professor is gone');
});

test('POST /api/recommend: excludeIds is sanitized and can empty the list when it covers the whole pool', async () => {
  mockOpenAlexHappyPath();
  // Garbage tokens are dropped (only /^A\d+$/ shapes survive). Excluding BOTH stub
  // authors leaves nothing → empty array, still 200 (honest, no padding, no crash).
  const res = await request(app)
    .post('/api/recommend')
    .send({
      interests: ['machine learning'],
      field: 'Computer Science',
      excludeIds: ['not-an-id', 'A123 OR 1=1', 42, null, 'A2000', 'A1000'],
    });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.professors));
  assert.equal(res.body.professors.length, 0, 'excluding the whole pool yields an empty list, not a crash');
});
