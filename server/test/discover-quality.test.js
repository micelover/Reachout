// Quality-gate tests for the browse NAME-search path. A keyboard-mash query like
// "sdf" routes through discover() → discoverByName(), which hits OpenAlex
// /authors?filter=display_name.search:sdf. OpenAlex returns spam/garbage author
// records (no institution, ~0 citations) that used to render as real cards. The
// hasScholarlyFootprint() gate must drop those while keeping legitimate authors
// (even early-career ones with one citation or one listed institution).
//
// All upstreams are mocked via global.fetch — offline, deterministic, no network.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app, cache, hasScholarlyFootprint } from '../index.js';

const realFetch = global.fetch;

beforeEach(() => {
  cache.clear();
});

afterEach(() => {
  global.fetch = realFetch;
});

// Same fetch stub shape used in routes.test.js.
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

// Recent counts_by_year so isActiveAuthor() passes for every fixture — isolates the
// footprint gate as the only thing that can differ between junk and legit records.
const Y = new Date().getFullYear();
const ACTIVE_COUNTS = [{ year: Y, works_count: 3, cited_by_count: 0 }];

// ─── Direct unit coverage of the gate ────────────────────────────────────────
test('hasScholarlyFootprint: junk record (no inst, 0 cites, no index) is dropped', () => {
  assert.equal(
    hasScholarlyFootprint({
      display_name: 'sdfsdf sdf sdf',
      last_known_institutions: [],
      cited_by_count: 0,
      summary_stats: { h_index: 0, i10_index: 0 },
    }),
    false
  );
});

test('hasScholarlyFootprint: any single scholarly signal keeps the author', () => {
  // Listed institution only (0 cites, no index) — early-career professor.
  assert.equal(
    hasScholarlyFootprint({
      last_known_institutions: [{ id: 'https://openalex.org/I1', display_name: 'MIT' }],
      cited_by_count: 0,
      summary_stats: { h_index: 0, i10_index: 0 },
    }),
    true
  );
  // No institution, but a cited paper.
  assert.equal(
    hasScholarlyFootprint({ last_known_institutions: [], cited_by_count: 12, summary_stats: {} }),
    true
  );
  // No institution, 0 cites, but a positive i10-index.
  assert.equal(
    hasScholarlyFootprint({ last_known_institutions: [], cited_by_count: 0, summary_stats: { i10_index: 2 } }),
    true
  );
});

// ─── End-to-end through GET /api/discover (name path) ────────────────────────
test('GET /api/discover name-search filters junk spam records, keeps legit authors', async () => {
  // Capture the OpenAlex /authors request URL so we can lock in the server-side floor.
  let authorsUrl = null;
  mockFetch([
    // Empty topics → no field match → discover() routes to discoverByName('sdf').
    { match: (u) => u.includes('/topics'), json: { results: [] } },
    // /authors name search: 1 junk + 2 legit, all "active" + Latin-named so only
    // the footprint gate decides who ships.
    {
      match: (u) => {
        if (!u.includes('/authors')) return false;
        authorsUrl = u;
        return true;
      },
      json: {
        meta: { count: 3 },
        results: [
          // (a) Junk: no institution, 0 citations, 0 h/i10-index — must be DROPPED.
          {
            id: 'https://openalex.org/A_JUNK',
            display_name: 'sdfsdf sdf sdf sdf df',
            last_known_institutions: [],
            topics: [{ id: 'https://openalex.org/T999', display_name: 'Some Topic', count: 1 }],
            works_count: 6,
            cited_by_count: 0,
            summary_stats: { h_index: 0, i10_index: 0 },
            counts_by_year: ACTIVE_COUNTS,
          },
          // (b) Legit early-career: listed institution, 0 citations — must SURVIVE.
          {
            id: 'https://openalex.org/A_INST',
            display_name: 'Jane Researcher',
            last_known_institutions: [
              { id: 'https://openalex.org/I63966007', display_name: 'Stanford University', country_code: 'US', type: 'education' },
            ],
            topics: [{ id: 'https://openalex.org/T100', display_name: 'Genomics', count: 8 }],
            works_count: 9,
            cited_by_count: 0,
            summary_stats: { h_index: 0, i10_index: 0 },
            counts_by_year: ACTIVE_COUNTS,
          },
          // (c) Legit, no institution but a cited paper — must SURVIVE.
          {
            id: 'https://openalex.org/A_CITED',
            display_name: 'John Independent',
            last_known_institutions: [],
            topics: [{ id: 'https://openalex.org/T200', display_name: 'Topology', count: 5 }],
            works_count: 7,
            cited_by_count: 14,
            summary_stats: { h_index: 1, i10_index: 0 },
            counts_by_year: ACTIVE_COUNTS,
          },
        ],
      },
    },
  ]);

  const res = await request(app).get('/api/discover?field=sdf&per_page=10');
  assert.equal(res.status, 200);
  assert.equal(res.body.mode, 'name');

  // The name-search query must carry both the works_count:>4 floor and the
  // display_name search (filter is URL-encoded, but the field tokens survive).
  assert.ok(authorsUrl, 'OpenAlex /authors was queried');
  assert.match(authorsUrl, /works_count/);
  assert.match(authorsUrl, /display_name\.search/);

  const ids = res.body.results.map((r) => r.id);
  assert.ok(!ids.includes('A_JUNK'), 'junk spam record must be filtered out');
  assert.ok(ids.includes('A_INST'), 'legit professor with a listed institution must survive');
  assert.ok(ids.includes('A_CITED'), 'legit author with a cited paper must survive');
  assert.equal(res.body.results.length, 2);
});
