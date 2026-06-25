// Tests for location-proximity ranking: the haversine/decay helpers, the durable
// institution-geo batch resolver (batching + negative caching), and the end-to-end
// /api/recommend boost (nearby professors rise; gating keeps no-location scores
// untouched) + the geo-enriched /api/schools autocomplete.
//
// Same offline harness as recommend.test.js: supertest drives the app in process,
// every upstream call is a URL-matching fetch stub. Run: cd server && npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {
  app, cache,
  haversineKm, proximity01, PROX_CONFIG, resolveInstitutionGeos,
} from '../index.js';

const realFetch = global.fetch;
beforeEach(() => { cache.clear(); });
afterEach(() => { global.fetch = realFetch; });

function mockFetch(routes) {
  global.fetch = async (url) => {
    const u = String(url);
    const r = routes.find((x) => x.match(u));
    if (!r) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    return {
      ok: r.ok !== undefined ? r.ok : true,
      status: r.status || 200,
      headers: { get: () => 'application/json' },
      json: async () => r.json ?? {},
      text: async () => r.text ?? '',
    };
  };
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

test('haversineKm: known distances within tolerance; invalid input → null', () => {
  // SF ↔ NYC ≈ 4130 km; SF ↔ Stanford ≈ 44 km; identical points = 0.
  const sf = { lat: 37.7749, lng: -122.4194 };
  const nyc = { lat: 40.7128, lng: -74.0060 };
  const stanford = { lat: 37.4275, lng: -122.1697 };
  assert.ok(Math.abs(haversineKm(sf, nyc) - 4130) < 80, 'SF↔NYC ≈ 4130 km');
  assert.ok(Math.abs(haversineKm(sf, stanford) - 44) < 10, 'SF↔Stanford ≈ 44 km');
  assert.equal(haversineKm(sf, sf), 0, 'identical points = 0');
  assert.equal(haversineKm(sf, null), null, 'missing point → null');
  assert.equal(haversineKm(sf, { lat: 1 }), null, 'missing lng → null');
});

test('proximity01: monotonic decay, floor → 1, unknown → null', () => {
  assert.equal(proximity01(0), 1, 'same spot → 1');
  assert.equal(proximity01(PROX_CONFIG.floorKm - 1), 1, 'inside floor → 1');
  const p50 = proximity01(50), p150 = proximity01(150), p600 = proximity01(600), p4000 = proximity01(4000);
  assert.ok(p50 > p150 && p150 > p600 && p600 > p4000, 'strictly decreasing with distance');
  assert.ok(Math.abs(p50 - 0.846) < 0.02, '~50 km ≈ 0.85');
  assert.ok(p4000 < 0.001, '~4000 km ≈ 0');
  assert.equal(proximity01(NaN), null, 'unknown distance → null (gated out)');
  // The max boost is bounded so the nudge stays gentle.
  assert.ok(Math.round(69 * PROX_CONFIG.wProx) <= 9, 'max boost ≤ ~8 match points');
});

// ── Institution-geo batch resolver: batching + negative caching ──────────────

test('resolveInstitutionGeos: one batched call, caches hits AND misses', async () => {
  let calls = 0;
  mockFetch([
    {
      match: (u) => u.includes('/institutions?filter=ids.openalex'),
      json: {
        results: [
          { id: 'https://openalex.org/I1', geo: { latitude: 37.43, longitude: -122.17, country_code: 'US' } },
          { id: 'https://openalex.org/I2', geo: { latitude: 40.71, longitude: -74.0, country_code: 'US' } },
          // I3 intentionally omitted → negative-cached.
        ],
      },
    },
  ]);
  const countingFetch = global.fetch;
  global.fetch = async (...a) => { calls++; return countingFetch(...a); };

  const m1 = await resolveInstitutionGeos(['I1', 'I2', 'I3', 'bad-id']);
  assert.equal(calls, 1, 'a single batched OpenAlex call for the chunk');
  assert.deepEqual(m1.get('I1'), { lat: 37.43, lng: -122.17, country: 'US' });
  assert.ok(m1.has('I2'), 'I2 resolved');
  assert.equal(m1.has('I3'), false, 'I3 has no geo → absent from the map');

  const m2 = await resolveInstitutionGeos(['I1', 'I2', 'I3']);
  assert.equal(calls, 1, 'second call fully served from cache (incl. the I3 miss) — no refetch');
  assert.ok(m2.has('I1') && m2.has('I2'), 'cached hits returned');
});

// ── End-to-end /api/recommend: proximity boost + gating ──────────────────────

const TOPIC_FULL = 'https://openalex.org/T999';
const FIELD_FULL = 'https://openalex.org/fields/17';
const SUBFIELD_FULL = 'https://openalex.org/subfields/1702';
const yr = new Date().getFullYear();

const topicsJson = {
  results: [{
    id: TOPIC_FULL, display_name: 'Machine Learning',
    field: { id: FIELD_FULL, display_name: 'Computer Science' },
    subfield: { id: SUBFIELD_FULL, display_name: 'Artificial Intelligence' },
  }],
};
const mkTopic = (count) => ({
  id: TOPIC_FULL, display_name: 'Machine Learning', count,
  field: { id: FIELD_FULL, display_name: 'Computer Science' },
  subfield: { id: SUBFIELD_FULL, display_name: 'Artificial Intelligence' },
});
// Two authors with IDENTICAL scoring inputs — only their institution differs, so
// any score gap is purely location proximity.
const authorAt = (aid, name, instId, instName) => ({
  id: `https://openalex.org/${aid}`,
  display_name: name,
  works_count: 40, cited_by_count: 1200,
  last_known_institutions: [{ id: `https://openalex.org/${instId}`, display_name: instName, country_code: 'US', type: 'education' }],
  topics: [mkTopic(25)],
  summary_stats: { h_index: 14, i10_index: 18 },
  counts_by_year: [{ year: yr, works_count: 6 }, { year: yr - 1, works_count: 5 }],
});
const authorsJson = {
  meta: { count: 2 },
  results: [authorAt('A1', 'Dr. Near', 'I1', 'Near U'), authorAt('A2', 'Dr. Far', 'I2', 'Far U')],
};
const geoJson = {
  results: [
    { id: 'https://openalex.org/I1', geo: { latitude: 37.4275, longitude: -122.1697, country_code: 'US' } }, // Stanford-ish
    { id: 'https://openalex.org/I2', geo: { latitude: 40.7128, longitude: -74.0060, country_code: 'US' } },   // NYC
  ],
};
function mockRecommend() {
  mockFetch([
    { match: (u) => u.includes('/institutions?filter=ids.openalex'), json: geoJson },
    { match: (u) => u.includes('/topics') || u.includes('/autocomplete/topics'), json: topicsJson },
    { match: (u) => u.includes('/authors'), json: authorsJson },
  ]);
}
const SF = { lat: 37.7749, lng: -122.4194, country: 'US' }; // ~44 km from I1, ~4130 km from I2

test('POST /api/recommend: a nearby professor is boosted above an identical far one', async () => {
  mockRecommend();
  const res = await request(app)
    .post('/api/recommend')
    .send({ interests: ['machine learning'], field: 'Computer Science', institutionLoc: SF });

  assert.equal(res.status, 200);
  const near = res.body.professors.find((p) => p.name === 'Dr. Near');
  const far = res.body.professors.find((p) => p.name === 'Dr. Far');
  assert.ok(near && far, 'both professors present');
  assert.ok(near.matchScore > far.matchScore, `near ${near.matchScore} > far ${far.matchScore}`);
  assert.equal(res.body.professors[0].name, 'Dr. Near', 'nearby professor ranked first');
  assert.ok(near.breakdown.proximity >= 80, 'near proximity ~0.86 → ~86');
  assert.ok(far.breakdown.proximity <= 1, 'far proximity ≈ 0');
  assert.ok(near.breakdown.reasons.includes('Right in your area'), 'leads with the location reason');
});

test('POST /api/recommend: GATING — no student location leaves scores untouched, proximity null', async () => {
  mockRecommend();
  const res = await request(app)
    .post('/api/recommend')
    .send({ interests: ['machine learning'], field: 'Computer Science' }); // no institution*

  assert.equal(res.status, 200);
  const near = res.body.professors.find((p) => p.name === 'Dr. Near');
  const far = res.body.professors.find((p) => p.name === 'Dr. Far');
  assert.equal(near.matchScore, far.matchScore, 'identical inputs → identical score (no boost)');
  assert.equal(near.breakdown.proximity, null, 'proximity null when no location');
  assert.equal(far.breakdown.proximity, null, 'proximity null when no location');
  assert.ok(!near.breakdown.reasons.includes('Right in your area'), 'no location reason when gated');
});

// ── /api/schools enrichment: id/qid + coordinates ────────────────────────────

test('GET /api/schools: returns institution id + coordinates; Wikidata-only rows have id:""', async () => {
  mockFetch([
    {
      match: (u) => u.includes('/autocomplete/institutions'),
      json: { results: [{ id: 'https://openalex.org/I50', display_name: 'Test University', hint: 'Testville, US' }] },
    },
    {
      match: (u) => u.includes('wikidata.org') && u.includes('wbgetentities'),
      json: { entities: { Q777: { claims: { P625: [{ mainsnak: { datavalue: { value: { latitude: 34.05, longitude: -118.24 } } } }] } } } },
    },
    {
      match: (u) => u.includes('wikidata.org'),
      json: { query: { pages: { '1': { index: 1, title: 'Q777', entityterms: { label: ['Test High School'] } } } } },
    },
    {
      match: (u) => u.includes('/institutions?filter=ids.openalex'),
      json: { results: [{ id: 'https://openalex.org/I50', geo: { latitude: 37.0, longitude: -122.0, country_code: 'US' } }] },
    },
  ]);

  const res = await request(app).get('/api/schools?q=test');
  assert.equal(res.status, 200);
  const uni = res.body.results.find((r) => r.name === 'Test University');
  const hs = res.body.results.find((r) => r.name === 'Test High School');
  assert.ok(uni, 'university row present');
  assert.equal(uni.id, 'I50', 'OpenAlex id surfaced (stripped)');
  assert.equal(uni.lat, 37.0, 'university latitude attached');
  assert.equal(uni.lng, -122.0, 'university longitude attached');
  assert.ok(hs, 'high-school row present');
  assert.equal(hs.id, '', 'Wikidata-only row has empty OpenAlex id');
  assert.equal(hs.lat, 34.05, 'high-school latitude from Wikidata P625');
});
