// Security-hardening contract tests (H1 auth + per-account cap, H2 id-injection
// rejection, M3 no upstream-internal leakage). Mirrors the harness in routes.test.js
// and resume-ratelimit.test.js: supertest drives the Express app in-process, every
// upstream (OpenAlex / Anthropic) is mocked, the rate-limit + cache slots ride the
// in-memory `cache` Map (Firestore is dormant under NODE_ENV=test), and the
// verifyFirebaseToken test seam treats `Bearer test:<uid>` as { uid }. Offline,
// deterministic, zero Anthropic spend. Run: cd server && npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import Anthropic from '@anthropic-ai/sdk';
import { app, cache, reserveDailyAction } from '../index.js';

const realFetch = global.fetch;
const realCreate = Anthropic.Messages.prototype.create;

beforeEach(() => {
  cache.clear(); // rate-limit slots + email cache ride the in-memory Map — isolate cases
});

afterEach(() => {
  global.fetch = realFetch;
  Anthropic.Messages.prototype.create = realCreate;
  delete process.env.ANTHROPIC_API_KEY;
});

// Match request URLs to canned JSON/text (same shape as routes.test.js mockFetch).
function mockFetch(routes) {
  global.fetch = async (url) => {
    const u = String(url);
    const r = routes.find((x) => x.match(u));
    if (!r) return { ok: false, status: 404, headers: { get: () => 'application/json' }, json: async () => ({}), text: async () => '' };
    return {
      ok: r.ok !== undefined ? r.ok : true,
      status: r.status || 200,
      headers: { get: () => 'application/json' },
      json: async () => r.json ?? {},
      text: async () => r.text ?? '',
    };
  };
}

// Stub Anthropic so `new Anthropic().messages.create(...)` resolves to the given text
// block (no network, no token spend). Mirrors routes.test.js mockAnthropicText.
function mockAnthropicText(text) {
  process.env.ANTHROPIC_API_KEY = 'sk-test-fake';
  Anthropic.Messages.prototype.create = async () => ({ content: [{ type: 'text', text }] });
}

// Stub Anthropic so the create call throws — exercises a handler's catch (refund + 502).
function mockAnthropicThrow() {
  process.env.ANTHROPIC_API_KEY = 'sk-test-fake';
  Anthropic.Messages.prototype.create = async () => { throw new Error('upstream Anthropic boom'); };
}

// OpenAlex author + works fixtures the draft-email route needs once it's past auth.
function mockDraftEmailUpstream() {
  mockFetch([
    {
      match: (u) => /\/authors\/A1(\?|$|%)/.test(u),
      json: {
        id: 'https://openalex.org/A1',
        display_name: 'Ada Lovelace',
        last_known_institutions: [{ display_name: 'Analytical Engine Lab', country_code: 'GB' }],
        topics: [{ id: 'https://openalex.org/T1', display_name: 'Computing', count: 10 }],
      },
    },
    {
      match: (u) => u.includes('/works'),
      json: { results: [{ id: 'https://openalex.org/W1', title: 'Notes on the Engine', publication_year: 1843 }] },
    },
  ]);
}

// A minimal valid merge-profile body (two objects → clears input validation).
const MERGE_BODY = { existing: { name: 'Ada' }, incoming: { name: 'A. Lovelace' } };

// ════════════════════════════════════════════════════════════════════════════
// H1 — auth + per-account daily cap on the two AI endpoints
// ════════════════════════════════════════════════════════════════════════════

// ── draft-email: auth gate ───────────────────────────────────────────────────

test('POST draft-email: no Authorization header → 401 (before upstream/Claude)', async () => {
  // No fetch/Anthropic mock: a working auth gate must return before either is touched.
  const res = await request(app).post('/api/professor/A1/draft-email').send({ student: {} });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Please sign in to draft an email.');
});

test('POST draft-email: malformed Authorization header → 401', async () => {
  const res = await request(app)
    .post('/api/professor/A1/draft-email')
    .set('Authorization', 'Basic xyz')
    .send({ student: {} });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Please sign in to draft an email.');
});

test('POST draft-email: valid test token → 200 with a drafted email', async () => {
  mockDraftEmailUpstream();
  mockAnthropicText('```json\n' + JSON.stringify({ subject: 'Your Engine work', body: 'Hi Prof.' }) + '\n```');
  const res = await request(app)
    .post('/api/professor/A1/draft-email')
    .set('Authorization', 'Bearer test:alice')
    .send({ student: { name: 'Sam' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.subject, 'Your Engine work');
  assert.equal(res.body.body, 'Hi Prof.');
  assert.equal(res.body.professor.name, 'Ada Lovelace');
});

test('POST draft-email: 31st call same day → 429 with Retry-After/resetAt/limit', async () => {
  // Pre-consume all 30 of bob's daily draft slots, then the next call is refused.
  for (let i = 0; i < 30; i++) {
    const r = await reserveDailyAction('bob', 'draft', 30);
    assert.equal(r.ok, true, `slot ${i + 1} reserved`);
  }
  // No upstream/Anthropic mock needed — the 429 returns before either.
  const res = await request(app)
    .post('/api/professor/A1/draft-email')
    .set('Authorization', 'Bearer test:bob')
    .send({ student: {} });
  assert.equal(res.status, 429);
  assert.equal(res.body.error, 'Max daily limit reached — come back tomorrow.');
  assert.equal(res.body.limit, 30);
  assert.ok(res.body.resetAt && typeof res.body.resetAt === 'string', 'carries a non-empty resetAt');
  assert.ok(Number(res.headers['retry-after']) > 0, 'Retry-After is a positive seconds value');
});

test('POST draft-email: Claude throws → 502 and the slot is refunded (retry allowed)', async () => {
  mockDraftEmailUpstream();
  mockAnthropicThrow();
  const failed = await request(app)
    .post('/api/professor/A1/draft-email')
    .set('Authorization', 'Bearer test:carol')
    .send({ student: {} });
  assert.equal(failed.status, 502);
  assert.equal(failed.body.error, 'Email drafting failed.');
  assert.equal(failed.body.detail, undefined, '502 no longer leaks `detail`');

  // Refund freed the slot: a subsequent good call succeeds (would 429 across 30 calls
  // if the failed one had been counted — here a single retry must simply work).
  mockDraftEmailUpstream();
  mockAnthropicText('```json\n' + JSON.stringify({ subject: 'S', body: 'B' }) + '\n```');
  const retry = await request(app)
    .post('/api/professor/A1/draft-email')
    .set('Authorization', 'Bearer test:carol')
    .send({ student: {} });
  assert.equal(retry.status, 200, 'refund released the slot for a retry');
});

// ── merge-profile: auth gate ─────────────────────────────────────────────────

test('POST merge-profile: no Authorization header → 401 (before Claude)', async () => {
  const res = await request(app).post('/api/merge-profile').send(MERGE_BODY);
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Please sign in to merge your profile.');
});

test('POST merge-profile: valid test token → 200 with a merged profile', async () => {
  mockAnthropicText('```json\n' + JSON.stringify({
    name: 'Ada Lovelace', institution: '', field: '', goals: [], interests: ['computing'],
    accomplishments: [], summary: '', sellingPoints: [],
  }) + '\n```');
  const res = await request(app)
    .post('/api/merge-profile')
    .set('Authorization', 'Bearer test:dave')
    .send(MERGE_BODY);
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Ada Lovelace');
  assert.deepEqual(res.body.interests, ['computing']);
});

test('POST merge-profile: 31st call same day → 429 with Retry-After/resetAt/limit', async () => {
  for (let i = 0; i < 30; i++) {
    const r = await reserveDailyAction('erin', 'merge', 30);
    assert.equal(r.ok, true, `slot ${i + 1} reserved`);
  }
  const res = await request(app)
    .post('/api/merge-profile')
    .set('Authorization', 'Bearer test:erin')
    .send(MERGE_BODY);
  assert.equal(res.status, 429);
  assert.equal(res.body.error, 'Max daily limit reached — come back tomorrow.');
  assert.equal(res.body.limit, 30);
  assert.ok(res.body.resetAt && typeof res.body.resetAt === 'string', 'carries a non-empty resetAt');
  assert.ok(Number(res.headers['retry-after']) > 0, 'Retry-After is a positive seconds value');
});

test('POST merge-profile: a 400 (non-object input) does NOT consume a slot', async () => {
  // Bad input 400s after auth but before the slot reservation — so a later valid call works.
  const bad = await request(app)
    .post('/api/merge-profile')
    .set('Authorization', 'Bearer test:frank')
    .send({ existing: 'nope', incoming: 'nope' });
  assert.equal(bad.status, 400);

  mockAnthropicText('```json\n' + JSON.stringify({ name: 'Ada' }) + '\n```');
  const good = await request(app)
    .post('/api/merge-profile')
    .set('Authorization', 'Bearer test:frank')
    .send(MERGE_BODY);
  assert.equal(good.status, 200, 'the rejected 400 burned no slot');
});

test('POST merge-profile: Claude throws → 502 and the slot is refunded', async () => {
  mockAnthropicThrow();
  const failed = await request(app)
    .post('/api/merge-profile')
    .set('Authorization', 'Bearer test:grace')
    .send(MERGE_BODY);
  assert.equal(failed.status, 502);
  assert.equal(failed.body.error, 'Profile merge failed.');
  assert.equal(failed.body.detail, undefined, '502 no longer leaks `detail`');

  mockAnthropicText('```json\n' + JSON.stringify({ name: 'Ada' }) + '\n```');
  const retry = await request(app)
    .post('/api/merge-profile')
    .set('Authorization', 'Bearer test:grace')
    .send(MERGE_BODY);
  assert.equal(retry.status, 200, 'refund released the slot for a retry');
});

// ════════════════════════════════════════════════════════════════════════════
// H2 — OpenAlex query-param injection via raw :authorId rejected with 400
// ════════════════════════════════════════════════════════════════════════════

// These ids would inject query params into the upstream /authors and /works?filter=
// URLs if interpolated raw. The validation gate must reject them BEFORE any fetch —
// so no upstream mock is needed (a leaked fetch would 404 and surface a different
// status/shape than the expected 400).
const INJECTION_IDS = ['A1|A2', 'A1%26select=id', 'A1%20OR%201'];

test('GET /api/professor/:id rejects an injecting authorId with 400', async () => {
  global.fetch = async () => { throw new Error('upstream must not be reached'); };
  for (const id of INJECTION_IDS) {
    const res = await request(app).get(`/api/professor/${id}`);
    assert.equal(res.status, 400, `${id} → 400`);
    assert.equal(res.body.error, 'Invalid author id.');
  }
});

test('GET /api/professor/:id/papers rejects an injecting authorId with 400', async () => {
  global.fetch = async () => { throw new Error('upstream must not be reached'); };
  for (const id of INJECTION_IDS) {
    const res = await request(app).get(`/api/professor/${id}/papers`);
    assert.equal(res.status, 400, `${id} → 400`);
    assert.equal(res.body.error, 'Invalid author id.');
  }
});

test('POST /api/professor/:id/email-guide rejects an injecting authorId with 400', async () => {
  global.fetch = async () => { throw new Error('upstream must not be reached'); };
  for (const id of INJECTION_IDS) {
    const res = await request(app).post(`/api/professor/${id}/email-guide`).send({ interests: ['x'] });
    assert.equal(res.status, 400, `${id} → 400`);
    assert.equal(res.body.error, 'Invalid author id.');
  }
});

test('POST /api/professor/:id/draft-email rejects an injecting authorId with 400 (after auth)', async () => {
  global.fetch = async () => { throw new Error('upstream must not be reached'); };
  for (const id of INJECTION_IDS) {
    const res = await request(app)
      .post(`/api/professor/${id}/draft-email`)
      .set('Authorization', 'Bearer test:heidi')
      .send({ student: {} });
    assert.equal(res.status, 400, `${id} → 400`);
    assert.equal(res.body.error, 'Invalid author id.');
  }
});

test('GET /api/professor/:id/papers still serves a well-formed (canonicalizable) id', async () => {
  // A bare-digits id (no leading "A") must canonicalize to A<digits> and succeed.
  mockFetch([
    { match: (u) => /\/authors\/A1(\?|$|%)/.test(u), json: { id: 'https://openalex.org/A1', display_name: 'Ada', works_count: 1 } },
    { match: (u) => u.includes('/works'), json: { results: [] } },
  ]);
  const res = await request(app).get('/api/professor/1/papers');
  assert.equal(res.status, 200);
  assert.equal(res.body.authorId, 'A1', 'bare digits canonicalize to A1');
});

// ════════════════════════════════════════════════════════════════════════════
// M3 — error responses no longer leak upstream internals (detail / raw)
// ════════════════════════════════════════════════════════════════════════════

test('502s carry only `error` — no `detail` (discover / professor)', async () => {
  global.fetch = async () => { throw new Error('SECRET internal path/IP leak'); };

  const discover = await request(app).get('/api/discover?field=robotics');
  assert.equal(discover.status, 502);
  assert.equal(discover.body.detail, undefined, 'discover 502 leaks no detail');
  assert.ok(!JSON.stringify(discover.body).includes('SECRET'), 'no upstream message leaks');

  const prof = await request(app).get('/api/professor/A1');
  assert.equal(prof.status, 502);
  assert.equal(prof.body.detail, undefined, 'professor 502 leaks no detail');
  assert.ok(!JSON.stringify(prof.body).includes('SECRET'), 'no upstream message leaks');
});

test('malformed-JSON 502 carries only `error` — no `raw` (merge-profile)', async () => {
  mockAnthropicText('definitely not json');
  const res = await request(app)
    .post('/api/merge-profile')
    .set('Authorization', 'Bearer test:ivan')
    .send(MERGE_BODY);
  assert.equal(res.status, 502);
  assert.match(res.body.error, /malformed JSON/);
  assert.equal(res.body.raw, undefined, 'no `raw` Claude payload leaks');
});

test('malformed-JSON 502 carries only `error` — no `raw` (draft-email)', async () => {
  mockDraftEmailUpstream();
  mockAnthropicText('definitely not json');
  const res = await request(app)
    .post('/api/professor/A1/draft-email')
    .set('Authorization', 'Bearer test:judy')
    .send({ student: {} });
  assert.equal(res.status, 502);
  assert.match(res.body.error, /malformed JSON/);
  assert.equal(res.body.raw, undefined, 'no `raw` Claude payload leaks');
});

// ════════════════════════════════════════════════════════════════════════════
// M1 — CORS: dev origins always allowed; unknown origins not reflected
// ════════════════════════════════════════════════════════════════════════════

test('CORS: a localhost Origin is reflected (dev always allowed)', async () => {
  const res = await request(app).get('/api/health').set('Origin', 'http://localhost:5173');
  assert.equal(res.status, 200);
  assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:5173');
  assert.match(res.headers['vary'] || '', /Origin/);
});

test('CORS: a file:// page (Origin "null") is reflected', async () => {
  const res = await request(app).get('/api/health').set('Origin', 'null');
  assert.equal(res.status, 200);
  assert.equal(res.headers['access-control-allow-origin'], 'null');
});

test('CORS: an unknown/disallowed Origin is NOT reflected (no wildcard)', async () => {
  const res = await request(app).get('/api/health').set('Origin', 'https://evil.example.com');
  assert.equal(res.status, 200);
  assert.equal(res.headers['access-control-allow-origin'], undefined, 'no ACAO header → browser blocks');
});

test('CORS: a request with NO Origin header passes through (curl / server-to-server)', async () => {
  const res = await request(app).get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('CORS: OPTIONS preflight → 204 with method/header allowances', async () => {
  const res = await request(app).options('/api/recommend').set('Origin', 'http://localhost:3000');
  assert.equal(res.status, 204);
  assert.match(res.headers['access-control-allow-methods'] || '', /POST/);
  assert.match(res.headers['access-control-allow-headers'] || '', /Authorization/);
  assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:3000');
});

// ════════════════════════════════════════════════════════════════════════════
// M2 — static handler serves ONLY index.html, never other repo-root files
// ════════════════════════════════════════════════════════════════════════════

test('M2: sensitive repo files return index.html, not their contents', async () => {
  // index.html is CDN-based; its body should contain an <html> tag and NOT any of the
  // sensitive markers that would appear if the real file were served.
  for (const path of ['/firestore.rules', '/server/index.js', '/CLAUDE.md', '/.firebaserc', '/firebase.json', '/card-mockups.html']) {
    const res = await request(app).get(path);
    assert.equal(res.status, 200, `${path} → 200 (SPA fallback)`);
    assert.match(res.text, /ReachOut/, `${path} served the SPA index.html`);
    // None of the served bodies should expose firestore rules / server source markers.
    assert.ok(!/rules_version|express\.json|service cloud\.firestore/.test(res.text), `${path} leaked no source`);
  }
});

test('M2: an /api path is NOT swallowed by the SPA fallback', async () => {
  const res = await request(app).get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true, '/api/* still routes to the JSON handler, not index.html');
});

test('M2: an unknown /api route 404s (regex did not swallow it into index.html)', async () => {
  const res = await request(app).get('/api/does-not-exist');
  assert.equal(res.status, 404);
  // A real Express 404 (e.g. "Cannot GET …"), NOT the SPA shell — the fallback regex
  // must exclude every /api path. The SPA index.html carries the "ReachOut" marker;
  // the stock 404 page does not.
  assert.ok(!/ReachOut/.test(res.text || ''), 'unknown /api route did not fall through to index.html');
});
