// Coverage for the Location filter (US states + research countries).
//
// Mirrors the harness in routes.test.js / recommend.test.js: supertest drives the
// Express app in-process and every OpenAlex call is mocked via a URL-matching fetch
// stub, so the suite is fully offline, deterministic, and spends no tokens.
//   Run: cd server && npm test
//
// Three layers are exercised:
//   1. GET /api/locations           — the static frozen picker payload (no upstream).
//   2. resolveLocations(tokens)      — token[] → institution id[] (the fragile core).
//   3. /api/discover + /api/recommend — token validation/parsing + union-with-unis +
//                                       strict 502 on upstream failure.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {
  app,
  cache,
  resolveLocations,
  LOCATIONS_PAYLOAD,
  LOC_RE,
  LOCATION_TOKEN_SET,
  US_STATES,
  RESEARCH_COUNTRIES,
} from '../index.js';

const realFetch = global.fetch;

beforeEach(() => {
  cache.clear(); // oaFetch memoizes by URL — start every case clean
});

afterEach(() => {
  global.fetch = realFetch;
});

// URL-matching fetch stub (same shape as routes.test.js / recommend.test.js).
// Each route may carry a `tap(url)` side-effect so a test can record the URLs that
// were actually hit (used to assert call counts + the institution-id filter union).
function mockFetch(routes) {
  global.fetch = async (url) => {
    const u = String(url);
    const r = routes.find((x) => x.match(u));
    if (!r) {
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    }
    if (r.tap) r.tap(u);
    return {
      ok: r.ok !== undefined ? r.ok : true,
      status: r.status || 200,
      headers: { get: () => 'application/json' },
      json: async () => r.json ?? {},
      text: async () => r.text ?? '',
    };
  };
}

// ── Canned topic/authors payloads for the discovery happy path ───────────────
// /api/discover field mode hits /topics (field → topic + field id), then /authors.
// We pin the topic to T999 and hand back one author carrying that exact topic at
// index 0 so it survives discoverByField's top-5 precision filter.
const TOPIC_FULL = 'https://openalex.org/T999';
const FIELD_FULL = 'https://openalex.org/fields/17';

const topicsJson = {
  results: [
    {
      id: TOPIC_FULL,
      display_name: 'Machine Learning',
      field: { id: FIELD_FULL, display_name: 'Computer Science' },
      subfield: { id: 'https://openalex.org/subfields/1702', display_name: 'AI' },
    },
  ],
};

const yr = new Date().getFullYear();
const authorsJson = {
  meta: { count: 1 },
  results: [
    {
      id: 'https://openalex.org/A1000',
      display_name: 'Dr. Test Author',
      works_count: 40,
      cited_by_count: 1200,
      last_known_institutions: [
        { id: 'https://openalex.org/I2', display_name: 'State College', country_code: 'US', type: 'education' },
      ],
      topics: [
        {
          id: TOPIC_FULL, display_name: 'Machine Learning', count: 25,
          field: { id: FIELD_FULL, display_name: 'Computer Science' },
          subfield: { id: 'https://openalex.org/subfields/1702' },
        },
      ],
      summary_stats: { h_index: 14, i10_index: 18 },
      counts_by_year: [
        { year: yr, works_count: 6 },
        { year: yr - 1, works_count: 5 },
      ],
    },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// 1. GET /api/locations — the static frozen picker payload
// ════════════════════════════════════════════════════════════════════════════

test('GET /api/locations: 77 items (51 states + 26 countries), no OpenAlex call', async () => {
  let fetched = false;
  global.fetch = async (...a) => { fetched = true; return realFetch(...a); };

  const res = await request(app).get('/api/locations');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.locations), 'body.locations is an array');
  assert.equal(res.body.locations.length, 77, '51 states + 26 countries = 77');

  const states = res.body.locations.filter((l) => l.type === 'state');
  const countries = res.body.locations.filter((l) => l.type === 'country');
  assert.equal(states.length, 51, '50 states + DC');
  assert.equal(countries.length, 26, '26 research countries');

  assert.equal(fetched, false, 'GET /api/locations makes NO upstream call');
});

test('GET /api/locations: state items carry country:"US" + no hint; correct fields', async () => {
  const res = await request(app).get('/api/locations');
  for (const s of res.body.locations.filter((l) => l.type === 'state')) {
    assert.equal(s.country, 'US', `state ${s.token} has country:"US"`);
    assert.equal(s.hint, undefined, `state ${s.token} has NO hint`);
    assert.equal(typeof s.token, 'string');
    assert.equal(typeof s.label, 'string');
    assert.ok(s.token.length > 0 && s.label.length > 0);
  }
});

test('GET /api/locations: country items carry hint + no country; correct fields', async () => {
  const res = await request(app).get('/api/locations');
  for (const c of res.body.locations.filter((l) => l.type === 'country')) {
    assert.equal(typeof c.hint, 'string', `country ${c.token} has a hint`);
    assert.ok(c.hint.length > 0);
    assert.equal(c.country, undefined, `country ${c.token} has NO country field`);
    assert.equal(typeof c.token, 'string');
    assert.equal(typeof c.label, 'string');
  }
});

test('GET /api/locations: every token matches LOC_RE and is in LOCATION_TOKEN_SET', async () => {
  const res = await request(app).get('/api/locations');
  for (const l of res.body.locations) {
    assert.ok(LOC_RE.test(l.token), `${l.token} matches LOC_RE`);
    assert.ok(LOCATION_TOKEN_SET.has(l.token), `${l.token} is a known token`);
  }
});

test('GET /api/locations: sets a 1-day public Cache-Control header', async () => {
  const res = await request(app).get('/api/locations');
  assert.equal(res.headers['cache-control'], 'public, max-age=86400');
});

test('LOCATIONS_PAYLOAD is frozen (the module-load singleton is immutable)', () => {
  assert.ok(Object.isFrozen(LOCATIONS_PAYLOAD), 'payload object frozen');
  assert.ok(Object.isFrozen(LOCATIONS_PAYLOAD.locations), 'locations array frozen');
});

// ════════════════════════════════════════════════════════════════════════════
// 2. resolveLocations(tokens) — token[] → institution id[]  (the fragile core)
// ════════════════════════════════════════════════════════════════════════════

test('resolveLocations([]): empty input makes NO upstream call and returns []', async () => {
  // Critical backward-compat hot path: requests that omit `locations` must not
  // touch OpenAlex at all.
  let calls = 0;
  global.fetch = async (...a) => { calls++; return realFetch(...a); };

  const ids = await resolveLocations([]);
  assert.deepEqual(ids, []);
  assert.equal(calls, 0, 'no fetch on the empty-tokens path');
});

test('resolveLocations(non-array): defensively returns [] with no upstream call', async () => {
  let calls = 0;
  global.fetch = async (...a) => { calls++; return realFetch(...a); };
  assert.deepEqual(await resolveLocations(undefined), []);
  assert.deepEqual(await resolveLocations(null), []);
  assert.equal(calls, 0);
});

test('resolveLocations(["DE"]): one country issues the country_code: query, ids capped at 40', async () => {
  const hits = [];
  // 45 institutions back; resolution caps each country at its top 40.
  const insts = Array.from({ length: 45 }, (_, i) => ({
    id: `https://openalex.org/I${1000 + i}`, works_count: 1000 - i,
  }));
  mockFetch([
    {
      match: (u) => u.includes('/institutions') && u.includes('country_code:DE'),
      tap: (u) => hits.push(u),
      json: { results: insts },
    },
  ]);

  const ids = await resolveLocations(['DE']);
  assert.equal(hits.length, 1, 'exactly one institutions query for the single country');
  assert.equal(ids.length, 40, 'country ids capped at 40');
  assert.ok(ids.every((id) => /^I\d+$/.test(id)), 'short institution ids only');
  assert.equal(ids[0], 'I1000', 'preserves works_count-desc order from upstream');
});

test('resolveLocations(states): one SHARED US bucket call partitioned by geo.region', async () => {
  // Three states resolved together must issue ONE shared US bucket call (identical
  // URL for every state) — NOT one call per state. Institutions are partitioned in
  // JS by their FULL geo.region name; entities with geo.region:null are skipped.
  const bucketCalls = [];
  mockFetch([
    {
      match: (u) => u.includes('/institutions') && u.includes('country_code:US'),
      tap: (u) => bucketCalls.push(u),
      json: {
        results: [
          { id: 'https://openalex.org/I1', geo: { region: 'California' }, works_count: 900 },
          { id: 'https://openalex.org/I2', geo: { region: 'California' }, works_count: 800 },
          { id: 'https://openalex.org/I3', geo: { region: 'Massachusetts' }, works_count: 700 },
          // geo.region:null — un-attributable, MUST be skipped (not leaked into any state).
          { id: 'https://openalex.org/I4', geo: { region: null }, works_count: 600 },
          { id: 'https://openalex.org/I5', geo: { region: 'New York' }, works_count: 500 },
        ],
      },
    },
  ]);

  const ids = await resolveLocations(['US-CA', 'US-MA', 'US-NY']);
  assert.equal(bucketCalls.length, 1, 'states share ONE bucket fetch, partitioned in JS');
  // CA → I1,I2 ; MA → I3 ; NY → I5 ; the null-region I4 is dropped entirely.
  assert.deepEqual(new Set(ids), new Set(['I1', 'I2', 'I3', 'I5']));
  assert.ok(!ids.includes('I4'), 'null geo.region institution is skipped');
});

test('resolveLocations: a state with no matching region partition yields no ids', async () => {
  mockFetch([
    {
      match: (u) => u.includes('/institutions') && u.includes('country_code:US'),
      json: {
        results: [
          { id: 'https://openalex.org/I1', geo: { region: 'California' }, works_count: 900 },
        ],
      },
    },
  ]);
  // US-WY (Wyoming) has no entity in the bucket → empty, no crash.
  const ids = await resolveLocations(['US-WY']);
  assert.deepEqual(ids, []);
});

test('resolveLocations: merged output is truncated at 150 and deduped', async () => {
  // 5 countries × 40 ids each (distinct per country) = 200 unioned → the cap
  // branch (out.size >= 150) must truncate to exactly 150 with no duplicates.
  // Each country returns a DISTINCT id namespace keyed off its ISO-2 code so the
  // union genuinely exceeds 150 rather than collapsing on dedupe.
  mockFetch([
    {
      match: (u) => u.includes('/institutions') && u.includes('country_code:'),
      json: {}, // overridden below by per-code matching
      tap: () => {},
    },
  ]);
  // Replace with a code-aware stub so each country yields its own 40 ids.
  global.fetch = async (url) => {
    const u = String(url);
    const code = (decodeURIComponent(u).match(/country_code:([A-Z]{2})/) || [])[1] || 'XX';
    const insts = Array.from({ length: 40 }, (_, i) => ({
      id: `https://openalex.org/I${code}${i}`, works_count: 1000 - i,
    }));
    return {
      ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => ({ results: insts }), text: async () => '',
    };
  };

  const ids = await resolveLocations(['DE', 'FR', 'IT', 'ES', 'NL']);
  assert.equal(ids.length, 150, 'merged output truncated to exactly 150');
  assert.equal(new Set(ids).size, ids.length, 'no duplicate institution ids');
});

test('resolveLocations: state + country together union (each issues its own query family)', async () => {
  const usHits = [];
  const deHits = [];
  mockFetch([
    {
      match: (u) => u.includes('/institutions') && u.includes('country_code:US'),
      tap: (u) => usHits.push(u),
      json: { results: [{ id: 'https://openalex.org/I1', geo: { region: 'California' }, works_count: 900 }] },
    },
    {
      match: (u) => u.includes('/institutions') && u.includes('country_code:DE'),
      tap: (u) => deHits.push(u),
      json: { results: [{ id: 'https://openalex.org/I9', works_count: 800 }] },
    },
  ]);
  const ids = await resolveLocations(['US-CA', 'DE']);
  assert.equal(usHits.length, 1, 'one shared US state bucket');
  assert.equal(deHits.length, 1, 'one country query for DE');
  assert.deepEqual(new Set(ids), new Set(['I1', 'I9']));
});

test('resolveLocations: STRICT — an oaFetch failure propagates (does not swallow to [])', async () => {
  global.fetch = async () => { throw new Error('network down'); };
  await assert.rejects(() => resolveLocations(['DE']), /network down/);
});

// ════════════════════════════════════════════════════════════════════════════
// 3a. GET /api/discover — token parsing/validation + union + strict 502
// ════════════════════════════════════════════════════════════════════════════

// Capture the institution-id filter the /authors query was built from, decoded.
function captureAuthorsInstFilter(authorsUrlCapture) {
  const u = authorsUrlCapture.value;
  assert.ok(u, 'an /authors query was issued');
  const decoded = decodeURIComponent(u);
  const m = decoded.match(/last_known_institutions\.id:([^,&]+)/);
  assert.ok(m, 'authors filter carries last_known_institutions.id');
  return m[1].split('|'); // the OR-joined institution ids
}

test('GET /api/discover: valid locations resolve + union into the authors institution filter', async () => {
  const authorsUrl = { value: null };
  mockFetch([
    { match: (u) => u.includes('/topics') || u.includes('/autocomplete/topics'), json: topicsJson },
    {
      match: (u) => u.includes('/institutions') && u.includes('country_code:DE'),
      json: { results: [{ id: 'https://openalex.org/I9', works_count: 800 }] },
    },
    {
      match: (u) => u.includes('/authors'),
      tap: (u) => { authorsUrl.value = u; },
      json: authorsJson,
    },
  ]);

  const res = await request(app).get('/api/discover?field=machine%20learning&unis=I63966007&locations=DE');
  assert.equal(res.status, 200);
  const instIds = captureAuthorsInstFilter(authorsUrl);
  assert.ok(instIds.includes('I63966007'), 'the selected uni is present');
  assert.ok(instIds.includes('I9'), 'the resolved DE institution id is unioned in');
});

test('GET /api/discover: lowercase token "us-ca" is uppercased+accepted (resolved)', async () => {
  const authorsUrl = { value: null };
  let bucketHit = 0;
  mockFetch([
    { match: (u) => u.includes('/topics') || u.includes('/autocomplete/topics'), json: topicsJson },
    {
      match: (u) => u.includes('/institutions') && u.includes('country_code:US'),
      tap: () => { bucketHit++; },
      json: { results: [{ id: 'https://openalex.org/I1', geo: { region: 'California' }, works_count: 900 }] },
    },
    { match: (u) => u.includes('/authors'), tap: (u) => { authorsUrl.value = u; }, json: authorsJson },
  ]);

  const res = await request(app).get('/api/discover?field=machine%20learning&unis=I777&locations=us-ca');
  assert.equal(res.status, 200);
  assert.equal(bucketHit, 1, 'us-ca normalized to US-CA and resolved via the US bucket');
  const instIds = captureAuthorsInstFilter(authorsUrl);
  assert.ok(instIds.includes('I1'), 'California institution unioned in despite lowercase input');
});

test('GET /api/discover: all-invalid locations === locations absent (byte-identical ids)', async () => {
  // The backward-compat guarantee: garbage tokens are dropped, and an all-invalid
  // `locations` yields the SAME merged institution filter as no `locations` at all.
  const absentUrl = { value: null };
  const invalidUrl = { value: null };

  // No /institutions route is registered — if an upstream resolution were
  // triggered it would 404 and perturb the result, which the assertion would catch.
  function run(capture) {
    mockFetch([
      { match: (u) => u.includes('/topics') || u.includes('/autocomplete/topics'), json: topicsJson },
      { match: (u) => u.includes('/authors'), tap: (u) => { capture.value = u; }, json: authorsJson },
    ]);
  }

  run(absentUrl);
  const r1 = await request(app).get('/api/discover?field=machine%20learning&unis=I555');
  cache.clear();
  run(invalidUrl);
  const r2 = await request(app).get('/api/discover?field=machine%20learning&unis=I555&locations=ZZ,US-ZZ,garbage,123');

  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  const a = captureAuthorsInstFilter(absentUrl);
  const b = captureAuthorsInstFilter(invalidUrl);
  assert.deepEqual(b, a, 'all-invalid locations produce the same institution filter as none');
  assert.deepEqual(b, ['I555'], 'only the valid uni survives — no phantom location ids');
});

test('GET /api/discover: token list is capped at 25 (>25 valid tokens → only 25 resolved)', async () => {
  // 26 valid country tokens; the parse site caps at 25, so the 26th never reaches
  // resolveLocations. We assert exactly 25 country queries were issued.
  const countryHits = new Set();
  mockFetch([
    { match: (u) => u.includes('/topics') || u.includes('/autocomplete/topics'), json: topicsJson },
    {
      match: (u) => u.includes('/institutions') && u.includes('country_code:'),
      tap: (u) => {
        const m = decodeURIComponent(String(u)).match(/country_code:([A-Z]{2})/);
        if (m) countryHits.add(m[1]);
      },
      json: { results: [{ id: 'https://openalex.org/I1', works_count: 1 }] },
    },
    { match: (u) => u.includes('/authors'), json: authorsJson },
  ]);

  const all26 = RESEARCH_COUNTRIES.map((c) => c.token).join(',');
  assert.equal(RESEARCH_COUNTRIES.length, 26, 'fixture assumption: 26 countries');
  const res = await request(app).get(`/api/discover?field=machine%20learning&locations=${all26}`);
  assert.equal(res.status, 200);
  assert.equal(countryHits.size, 25, 'only the first 25 tokens are resolved (cap)');
});

test('GET /api/discover: strict 502 when OpenAlex fails during location resolution', async () => {
  mockFetch([
    { match: (u) => u.includes('/topics') || u.includes('/autocomplete/topics'), json: topicsJson },
    // Location resolution fails hard (not a swallowed empty result).
    { match: (u) => u.includes('/institutions') && u.includes('country_code:DE'), ok: false, status: 500 },
    { match: (u) => u.includes('/authors'), json: authorsJson },
  ]);
  const res = await request(app).get('/api/discover?field=machine%20learning&locations=DE');
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'Failed to reach OpenAlex');
  assert.ok(res.body.detail, '502 carries a detail string');
});

// ════════════════════════════════════════════════════════════════════════════
// 3b. POST /api/recommend — token parsing/validation + union + strict 502
// ════════════════════════════════════════════════════════════════════════════

// Recommend's /authors filter (Branch B) also carries last_known_institutions.id.
function captureRecommendInstFilter(authorsUrlCapture) {
  return captureAuthorsInstFilter(authorsUrlCapture);
}

test('POST /api/recommend: locations[] resolve + union into the authors institution filter', async () => {
  const authorsUrl = { value: null };
  mockFetch([
    { match: (u) => u.includes('/topics') || u.includes('/autocomplete/topics'), json: topicsJson },
    {
      match: (u) => u.includes('/institutions') && u.includes('country_code:DE'),
      json: { results: [{ id: 'https://openalex.org/I9', works_count: 800 }] },
    },
    { match: (u) => u.includes('/authors'), tap: (u) => { authorsUrl.value = u; }, json: authorsJson },
  ]);

  const res = await request(app)
    .post('/api/recommend')
    .send({ interests: ['machine learning'], field: 'Computer Science', unis: ['I63966007'], locations: ['DE'] });
  assert.equal(res.status, 200);
  const instIds = captureRecommendInstFilter(authorsUrl);
  assert.ok(instIds.includes('I63966007'), 'selected uni present');
  assert.ok(instIds.includes('I9'), 'resolved DE institution unioned in');
});

test('POST /api/recommend: all-invalid locations === locations absent (no phantom ids)', async () => {
  const absentUrl = { value: null };
  const invalidUrl = { value: null };
  function run(capture) {
    mockFetch([
      { match: (u) => u.includes('/topics') || u.includes('/autocomplete/topics'), json: topicsJson },
      { match: (u) => u.includes('/authors'), tap: (u) => { capture.value = u; }, json: authorsJson },
    ]);
  }

  run(absentUrl);
  const r1 = await request(app)
    .post('/api/recommend')
    .send({ interests: ['machine learning'], field: 'Computer Science', unis: ['I555'] });
  cache.clear();
  run(invalidUrl);
  const r2 = await request(app)
    .post('/api/recommend')
    .send({ interests: ['machine learning'], field: 'Computer Science', unis: ['I555'], locations: ['zz', 'US-ZZ', 'garbage', 5] });

  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  const a = captureRecommendInstFilter(absentUrl);
  const b = captureRecommendInstFilter(invalidUrl);
  assert.deepEqual(b, a, 'all-invalid locations match the no-locations institution filter');
  assert.deepEqual(b, ['I555'], 'only the valid uni survives');
});

test('POST /api/recommend: lowercase + valid token normalizes and resolves via US bucket', async () => {
  let bucketHit = 0;
  const authorsUrl = { value: null };
  mockFetch([
    { match: (u) => u.includes('/topics') || u.includes('/autocomplete/topics'), json: topicsJson },
    {
      match: (u) => u.includes('/institutions') && u.includes('country_code:US'),
      tap: () => { bucketHit++; },
      json: { results: [{ id: 'https://openalex.org/I1', geo: { region: 'New York' }, works_count: 900 }] },
    },
    { match: (u) => u.includes('/authors'), tap: (u) => { authorsUrl.value = u; }, json: authorsJson },
  ]);

  const res = await request(app)
    .post('/api/recommend')
    .send({ interests: ['machine learning'], field: 'Computer Science', unis: ['I3'], locations: ['us-ny'] });
  assert.equal(res.status, 200);
  assert.equal(bucketHit, 1, 'us-ny normalized + resolved via the shared US bucket');
  const instIds = captureRecommendInstFilter(authorsUrl);
  assert.ok(instIds.includes('I1'), 'New York institution unioned in');
});

test('POST /api/recommend: strict 502 when OpenAlex fails during location resolution', async () => {
  mockFetch([
    { match: (u) => u.includes('/topics') || u.includes('/autocomplete/topics'), json: topicsJson },
    { match: (u) => u.includes('/institutions') && u.includes('country_code:DE'), ok: false, status: 500 },
    { match: (u) => u.includes('/authors'), json: authorsJson },
  ]);
  const res = await request(app)
    .post('/api/recommend')
    .send({ interests: ['machine learning'], field: 'Computer Science', locations: ['DE'] });
  assert.equal(res.status, 502, 'an upstream failure during resolution is an honest 502');
  assert.equal(res.body.error, 'Failed to reach OpenAlex');
});
