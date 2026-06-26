// Contract + unit tests for the 1-résumé-upload-per-day-per-account cap on
// POST /api/analyze-resume. Mirrors the harness in routes.test.js: supertest drives
// the Express app in process and the rate-limit slots live in the in-memory `cache`
// Map (Firestore is dormant under NODE_ENV=test), so `cache.clear()` isolates cases.
//
// The reserve-before-Claude ordering lets the 401/429 paths assert WITHOUT a mock and
// without spending Anthropic tokens — both return before any anthropic.messages.create.
// The two integration cases stub Anthropic via the prototype (same pattern as
// routes.test.js), never hitting the network. Run: cd server && npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import Anthropic from '@anthropic-ai/sdk';
import {
  app,
  cache,
  reserveDailyUpload,
  refundDailyUpload,
  dayKeyUTC,
  msUntilNextUtcMidnight,
} from '../index.js';

const realFetch = global.fetch;
const realCreate = Anthropic.Messages.prototype.create;

// A valid-looking résumé upload body (≥100-char base64-ish `data`, allowed mediaType).
// Used by the 429 path and the integration cases — clears input validation so the
// handler proceeds to the slot reservation.
const VALID_BODY = { data: 'A'.repeat(200), mediaType: 'application/pdf' };

beforeEach(() => {
  cache.clear(); // rate-limit slots ride the in-memory Map — start every case clean
});

afterEach(() => {
  global.fetch = realFetch;
  Anthropic.Messages.prototype.create = realCreate;
  delete process.env.ANTHROPIC_API_KEY;
});

// Stub Anthropic so `new Anthropic().messages.create(...)` resolves to the given text
// block (no network, no token spend). Mirrors routes.test.js mockAnthropicText.
function mockAnthropicText(text) {
  process.env.ANTHROPIC_API_KEY = 'sk-test-fake';
  Anthropic.Messages.prototype.create = async () => ({ content: [{ type: 'text', text }] });
}

// Stub Anthropic so the create call throws — exercises the handler's catch (refund + 502).
function mockAnthropicThrow() {
  process.env.ANTHROPIC_API_KEY = 'sk-test-fake';
  Anthropic.Messages.prototype.create = async () => { throw new Error('upstream Anthropic boom'); };
}

// ── 401: auth gates the route before input/slot/Claude ───────────────────────

test('POST /api/analyze-resume: no Authorization header → 401 (before Claude)', async () => {
  const res = await request(app).post('/api/analyze-resume').send(VALID_BODY);
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Please sign in to analyze a résumé.');
});

test('POST /api/analyze-resume: malformed Authorization header → 401', async () => {
  const res = await request(app)
    .post('/api/analyze-resume')
    .set('Authorization', 'Basic xyz')
    .send(VALID_BODY);
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Please sign in to analyze a résumé.');
});

// ── 429: a slot already used today short-circuits before Claude ──────────────

test('POST /api/analyze-resume: slot used today → 429 with resetAt/limit/Retry-After (before Claude)', async () => {
  // Pre-seed today's slot for alice, then a real upload should be refused.
  const seed = await reserveDailyUpload('alice');
  assert.equal(seed.ok, true, 'pre-seed reserves the day’s slot');

  const res = await request(app)
    .post('/api/analyze-resume')
    .set('Authorization', 'Bearer test:alice')
    .send(VALID_BODY);

  assert.equal(res.status, 429);
  assert.equal(res.body.error, 'Max daily limit reached — come back tomorrow.');
  assert.equal(res.body.limit, 1);
  assert.ok(res.body.resetAt && typeof res.body.resetAt === 'string', 'carries a non-empty resetAt');
  assert.ok(res.headers['retry-after'], 'Retry-After header present');
  assert.ok(Number(res.headers['retry-after']) > 0, 'Retry-After is a positive seconds value');
});

// ── Helper units: reserveDailyUpload / refundDailyUpload ─────────────────────

test('reserveDailyUpload: first reserve ok, immediate second reserve refused with ISO resetAt', async () => {
  const r1 = await reserveDailyUpload('bob');
  assert.equal(r1.ok, true, 'first reserve takes the slot');

  const r2 = await reserveDailyUpload('bob');
  assert.equal(r2.ok, false, 'second reserve is refused');
  assert.match(
    r2.resetAt,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    'refusal carries an ISO resetAt',
  );
});

test('refundDailyUpload: refund frees the slot so a later reserve succeeds again', async () => {
  assert.equal((await reserveDailyUpload('carol')).ok, true);
  await refundDailyUpload('carol');
  assert.equal((await reserveDailyUpload('carol')).ok, true, 'refund released the slot');
});

test('reserveDailyUpload: distinct uids are independent', async () => {
  assert.equal((await reserveDailyUpload('dave')).ok, true);
  assert.equal((await reserveDailyUpload('erin')).ok, true, 'erin not blocked by dave');
  assert.equal((await reserveDailyUpload('dave')).ok, false, 'dave still capped');
});

// ── Time helpers: document the UTC-rollover behavior ─────────────────────────

test('dayKeyUTC: returns YYYY-MM-DD for a fixed UTC date', () => {
  assert.equal(dayKeyUTC(new Date('2026-06-25T23:30:00Z')), '2026-06-25');
});

test('msUntilNextUtcMidnight: 23:00 UTC → exactly one hour to rollover', () => {
  assert.equal(msUntilNextUtcMidnight(Date.UTC(2026, 5, 25, 23, 0, 0)), 3600000);
});

// ── Integration: real handler ordering (Anthropic stubbed, no tokens) ────────

test('POST /api/analyze-resume: valid résumé → 200, slot consumed (second POST → 429)', async () => {
  // isResume:true + empty interests → 200 with no OpenAlex call, isolating the slot logic.
  mockAnthropicText('```json\n' + JSON.stringify({ isResume: true, interests: [] }) + '\n```');

  const first = await request(app)
    .post('/api/analyze-resume')
    .set('Authorization', 'Bearer test:frank')
    .send(VALID_BODY);
  assert.equal(first.status, 200, 'a valid résumé succeeds');
  assert.deepEqual(first.body.interests, []);

  const second = await request(app)
    .post('/api/analyze-resume')
    .set('Authorization', 'Bearer test:frank')
    .send(VALID_BODY);
  assert.equal(second.status, 429, 'the successful upload consumed the day’s slot');
});

test('POST /api/analyze-resume: Claude throws → 502 and the slot is refunded (next POST allowed)', async () => {
  mockAnthropicThrow();
  const failed = await request(app)
    .post('/api/analyze-resume')
    .set('Authorization', 'Bearer test:grace')
    .send(VALID_BODY);
  assert.equal(failed.status, 502, 'a thrown Claude call is an honest 502');

  // The refund freed the slot: a subsequent valid call succeeds (would be 429 if not refunded).
  mockAnthropicText('```json\n' + JSON.stringify({ isResume: true, interests: [] }) + '\n```');
  const retry = await request(app)
    .post('/api/analyze-resume')
    .set('Authorization', 'Bearer test:grace')
    .send(VALID_BODY);
  assert.equal(retry.status, 200, 'refund released the slot for a retry');
});
