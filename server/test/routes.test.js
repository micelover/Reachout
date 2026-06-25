// Route contract tests via supertest. Every upstream (OpenAlex / NCBI / Wikidata /
// Anthropic) is mocked so tests are offline, deterministic, and never spend tokens.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import Anthropic from '@anthropic-ai/sdk';
import { app, cache } from '../index.js';

const realFetch = global.fetch;
const realCreate = Anthropic.Messages.prototype.create;

beforeEach(() => {
  cache.clear();
});

afterEach(() => {
  global.fetch = realFetch;
  Anthropic.Messages.prototype.create = realCreate;
  delete process.env.ANTHROPIC_API_KEY;
});

// Build a fetch stub that matches request URLs to canned JSON/text responses.
// `routes` is an array of { match: (url)=>bool, status?, json?, text?, ok? }.
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

// Stub Anthropic so `new Anthropic().messages.create(...)` resolves to the given
// text block without any network call or token spend.
function mockAnthropicText(text) {
  process.env.ANTHROPIC_API_KEY = 'sk-test-fake';
  Anthropic.Messages.prototype.create = async () => ({
    content: [{ type: 'text', text }],
  });
}

// ─── GET /api/health ──────────────────────────────────────────────────────────
test('GET /api/health returns 200 and ok:true', async () => {
  const res = await request(app).get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

// ─── GET /api/discover ────────────────────────────────────────────────────────
test('GET /api/discover returns DTO shape on a healthy upstream', async () => {
  mockFetch([
    // resolveTopicId → /autocomplete/topics or /topics; accept any topics lookup.
    {
      match: (u) => u.includes('/topics') || u.includes('/autocomplete/topics'),
      json: {
        results: [
          {
            id: 'https://openalex.org/T10001',
            display_name: 'Robotics',
            field: { id: 'https://openalex.org/fields/22', display_name: 'Engineering' },
            subfield: { id: 'https://openalex.org/subfields/2207' },
          },
        ],
      },
    },
    // /authors filtered query.
    {
      match: (u) => u.includes('/authors'),
      json: {
        meta: { count: 1 },
        results: [
          {
            id: 'https://openalex.org/A1',
            display_name: 'Robo Prof',
            last_known_institutions: [{ display_name: 'MIT', country_code: 'US', type: 'education' }],
            topics: [
              { id: 'https://openalex.org/T10001', display_name: 'Robotics', count: 50,
                field: { id: 'https://openalex.org/fields/22' } },
            ],
            works_count: 100,
            cited_by_count: 5000,
          },
        ],
      },
    },
  ]);

  const res = await request(app).get('/api/discover?field=robotics&per_page=5');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.results));
  if (res.body.results.length) {
    const card = res.body.results[0];
    assert.equal(card.id, 'A1');
    assert.equal(card.fullId, 'https://openalex.org/A1');
    assert.equal(card.name, 'Robo Prof');
    assert.ok(typeof card.matchScore === 'number');
  }
});

test('GET /api/discover returns 502 when OpenAlex fails hard', async () => {
  // resolveTopicId itself throws → the outer catch returns 502.
  global.fetch = async () => { throw new Error('network down'); };
  const res = await request(app).get('/api/discover?field=robotics');
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'Failed to reach OpenAlex');
});

// ─── GET /api/professor/:authorId ────────────────────────────────────────────
test('GET /api/professor/:id returns profile + recentPapers DTO', async () => {
  mockFetch([
    {
      match: (u) => /\/authors\/A1(\?|$)/.test(u),
      json: {
        id: 'https://openalex.org/A1',
        display_name: 'Grace Hopper',
        last_known_institutions: [{ display_name: 'US Navy', country_code: 'US', type: 'government' }],
        topics: [{ id: 'https://openalex.org/T1', display_name: 'Compilers', count: 30 }],
        works_count: 80,
        cited_by_count: 12000,
      },
    },
    {
      match: (u) => u.includes('/works'),
      json: {
        results: [
          { id: 'https://openalex.org/W1', title: 'The Compiler', publication_year: 1952,
            primary_location: { source: { display_name: 'ACM' } }, cited_by_count: 999 },
        ],
      },
    },
  ]);

  const res = await request(app).get('/api/professor/A1');
  assert.equal(res.status, 200);
  assert.equal(res.body.profile.id, 'A1');
  assert.equal(res.body.profile.name, 'Grace Hopper');
  assert.ok(Array.isArray(res.body.recentPapers));
  assert.equal(res.body.recentPapers[0].title, 'The Compiler');
  assert.equal(res.body.latestPublication.id, 'W1');
});

test('GET /api/professor/:id returns 502 when OpenAlex is unreachable', async () => {
  global.fetch = async () => { throw new Error('boom'); };
  const res = await request(app).get('/api/professor/A1');
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'Failed to reach OpenAlex');
});

// ─── POST /api/analyze-resume ────────────────────────────────────────────────
test('POST /api/analyze-resume returns 400 on missing/too-small data', async () => {
  const res = await request(app).post('/api/analyze-resume').send({ data: 'short', mediaType: 'application/pdf' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Missing or too-small/);
});

test('POST /api/analyze-resume returns 400 on unsupported mediaType', async () => {
  const big = 'A'.repeat(200);
  const res = await request(app).post('/api/analyze-resume').send({ data: big, mediaType: 'text/plain' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Unsupported mediaType/);
});

test('POST /api/analyze-resume strips a ```json fence before JSON.parse', async () => {
  // Claude wraps JSON in a markdown fence; the route must strip it. isResume:false
  // short-circuits before any OpenAlex call, isolating the fence-strip behavior.
  mockAnthropicText('```json\n{"isResume": false}\n```');
  const big = 'A'.repeat(200);
  const res = await request(app).post('/api/analyze-resume').send({ data: big, mediaType: 'application/pdf' });
  // Fenced JSON parsed successfully → isResume:false → the 400 "not a resume" path.
  assert.equal(res.status, 400);
  assert.match(res.body.error, /doesn't look like a resume/);
});

test('POST /api/analyze-resume returns 502 when Claude returns malformed JSON', async () => {
  mockAnthropicText('I am not JSON at all, sorry.');
  const big = 'A'.repeat(200);
  const res = await request(app).post('/api/analyze-resume').send({ data: big, mediaType: 'application/pdf' });
  assert.equal(res.status, 502);
  assert.match(res.body.error, /malformed JSON/);
});

test('POST /api/analyze-resume returns parsed fields with no interests (no OpenAlex call)', async () => {
  mockAnthropicText('```json\n' + JSON.stringify({
    isResume: true,
    interests: [],
    summary: 'A promising student.',
    sellingPoints: ['hardworking'],
    accomplishments: ['Dean\'s list'],
  }) + '\n```');
  const big = 'A'.repeat(200);
  const res = await request(app).post('/api/analyze-resume').send({ data: big, mediaType: 'application/pdf' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.interests, []);
  assert.equal(res.body.summary, 'A promising student.');
  assert.deepEqual(res.body.professors, []);
});

// ─── GET /api/professor/:id/email — the deliberate always-200 exception ───────
test('GET /api/professor/:id/email ALWAYS returns 200, even when upstream throws', async () => {
  // Every fetch throws → the route catch must still 200 with a partial payload.
  global.fetch = async () => { throw new Error('total upstream failure'); };
  const res = await request(app).get('/api/professor/A1/email');
  assert.equal(res.status, 200);
  // Partial payload shape is preserved.
  assert.equal(res.body.email, null);
  assert.equal(res.body.mailtoEnabled, false);
  assert.ok('candidates' in res.body);
  assert.ok('facultySearchUrl' in res.body);
});

test('GET /api/professor/:id/email returns a guess payload from the institution pattern', async () => {
  mockFetch([
    {
      match: (u) => /\/authors\/A1(\?|$)/.test(u),
      json: {
        id: 'https://openalex.org/A1',
        display_name: 'Jane Smith',
        last_known_institutions: [{ id: 'https://openalex.org/I1', display_name: 'Stanford University' }],
      },
    },
    {
      match: (u) => u.includes('/works'),
      json: { results: [] },
    },
    {
      match: (u) => u.includes('/institutions/I1'),
      json: { homepage_url: 'https://www.stanford.edu' },
    },
    // pmidsToPmcids converter — no pmids, but guard anyway.
    { match: (u) => u.includes('idconv'), json: { records: [] } },
  ]);

  const res = await request(app).get('/api/professor/A1/email');
  assert.equal(res.status, 200);
  // No PMC/PubMed/PDF hits → Tier 4 institution-pattern guess.
  assert.equal(res.body.confidence, 'guess');
  assert.equal(res.body.email, 'jane.smith@stanford.edu');
  assert.equal(res.body.mailtoEnabled, false);
  assert.ok(res.body.candidates.includes('jsmith@stanford.edu'));
});
