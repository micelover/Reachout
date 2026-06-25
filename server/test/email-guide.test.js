// Route contract tests for POST /api/professor/:authorId/email-guide — the
// deterministic "Write your email" paper ranker. It makes NO Anthropic call: it
// fetches the professor's recent works from OpenAlex (each work carries topics[]
// AND an abstract inverted index), resolves the student's BROADENED bucket list
// ([field, ...interests, ...skills]) to topic targets via resolveTopicId (also
// OpenAlex), and scores each recent paper by BLENDING computeMatchScore (topical
// fit) with keyword overlap over interests/skills/accomplishments/field/summary.
// Returns the TOP 3 papers; hook === matches[0]. Every upstream is mocked so tests
// are offline, deterministic, and never spend tokens.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app, cache } from '../index.js';

const realFetch = global.fetch;

beforeEach(() => {
  cache.clear();
});

afterEach(() => {
  global.fetch = realFetch;
});

// Build a fetch stub that matches request URLs to canned JSON/text responses.
// `routes` is an array of { match: (url)=>bool, status?, json?, text?, ok? }.
// Same shape used by routes.test.js — do not diverge.
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

// ─── Realistic OpenAlex shapes ───────────────────────────────────────────────
// A topic candidate as returned by /topics?search= (fetchTopicCandidates reads
// id / display_name / field.id / subfield.id). Robotics → field 22, subfield 2207.
const ROBOTICS_TOPIC = {
  id: 'https://openalex.org/T100',
  display_name: 'Robotics',
  field: { id: 'https://openalex.org/fields/22', display_name: 'Engineering' },
  subfield: { id: 'https://openalex.org/subfields/2207', display_name: 'Control and Systems Engineering' },
};

// Turn a plain-text abstract into OpenAlex's inverted-index shape (word → [positions])
// so reconstructAbstract rebuilds the same text. Used to give papers distinct
// abstract keyword bags.
function invertedIndex(text) {
  const idx = {};
  text.split(/\s+/).forEach((word, pos) => {
    if (!word) return;
    (idx[word] = idx[word] || []).push(pos);
  });
  return idx;
}

// A recent work as returned by /works (the route reads id, title,
// publication_year, publication_date, cited_by_count, topics[],
// abstract_inverted_index). Each topic has id / display_name / field / subfield /
// count, ordered by count desc.
function work({ id, title, year, date, citedBy = 10, topics = [], abstract }) {
  return {
    id: `https://openalex.org/${id}`,
    title,
    publication_year: year,
    publication_date: date,
    type: 'article',
    cited_by_count: citedBy,
    topics,
    abstract_inverted_index: abstract ? invertedIndex(abstract) : undefined,
  };
}

// ─── 1. Ranked path: higher topical match wins over more-recent ──────────────
test('POST email-guide ranks the higher-match paper first and returns top-3', async () => {
  // Two recent works. W_RECENT is newer but its topics DON'T include the resolved
  // target (off-field). W_MATCH is older but leads with the target topic at rank 0
  // with a dominant count → strictly higher computeMatchScore. The ranker must
  // put W_MATCH first, mark ranked:true, and expose hook === matches[0].
  const W_RECENT = work({
    id: 'W_RECENT',
    title: 'A Survey of Medieval Poetry',
    year: 2024,
    date: '2024-05-01',
    citedBy: 5,
    topics: [
      {
        id: 'https://openalex.org/T900',
        display_name: 'Medieval Literature',
        field: { id: 'https://openalex.org/fields/12' },
        subfield: { id: 'https://openalex.org/subfields/1208' },
        count: 40,
      },
    ],
  });
  const W_MATCH = work({
    id: 'W_MATCH',
    title: 'Adaptive Control for Legged Robots',
    year: 2022,
    date: '2022-03-15',
    citedBy: 120,
    topics: [
      {
        id: 'https://openalex.org/T100', // === resolved target topicId after stripId
        display_name: 'Robotics',
        field: { id: 'https://openalex.org/fields/22' },
        subfield: { id: 'https://openalex.org/subfields/2207' },
        count: 80,
      },
    ],
  });

  mockFetch([
    // resolveTopicId / pickDominantField → /topics?search=
    { match: (u) => u.includes('/topics'), json: { results: [ROBOTICS_TOPIC] } },
    // recent works fetch
    { match: (u) => u.includes('/works'), json: { results: [W_RECENT, W_MATCH] } },
  ]);

  const res = await request(app)
    .post('/api/professor/A1/email-guide')
    .send({ interests: ['robotics'] });

  assert.equal(res.status, 200);
  assert.equal(res.body.authorId, 'A1');
  assert.ok(Array.isArray(res.body.matches), 'expected a matches array');
  assert.ok(res.body.matches.length <= 3, 'matches capped at 3');
  assert.equal(res.body.matches.length, 2, 'both papers returned, ordered');
  // hook MUST equal matches[0] (back-compat for the hook block).
  assert.deepEqual(res.body.hook, res.body.matches[0]);
  assert.equal(res.body.hook.ranked, true);
  // The higher-match (older) paper wins over the more-recent off-topic one.
  assert.equal(res.body.matches[0].paperId, 'W_MATCH');
  assert.equal(res.body.matches[0].title, 'Adaptive Control for Legged Robots');
  assert.equal(res.body.matches[0].year, 2022);
  // matchedTopic is the professor-topic display_name whose stripped id hit the target.
  assert.equal(res.body.matches[0].matchedTopic, 'Robotics');
  // matchedSource reports the student bucket the winning target came from. 'robotics'
  // was supplied via interests[] → 'interest'.
  assert.equal(res.body.matches[0].matchedSource, 'interest');
  // The off-topic paper is still present, just ranked second; it never hit a target,
  // so its matchedTopic/matchedSource stay null.
  assert.equal(res.body.matches[1].paperId, 'W_RECENT');
  assert.equal(res.body.matches[1].matchedTopic, null);
  assert.equal(res.body.matches[1].matchedSource, null);
});

// ─── 1b. matchedSource is 'skill' when the winning target came from skills[] ──
test('POST email-guide reports matchedSource:"skill" when a skill bucket drives the match', async () => {
  // 'robotics' is declared as a SKILL (not interest/field). resolveTopicId resolves
  // it to the Robotics target, and the paper leads with that topic → matchedSource
  // must be 'skill'.
  const W_MATCH = work({
    id: 'W_MATCH',
    title: 'Adaptive Control for Legged Robots',
    year: 2022,
    date: '2022-03-15',
    citedBy: 120,
    topics: [
      {
        id: 'https://openalex.org/T100', // === resolved target topicId after stripId
        display_name: 'Robotics',
        field: { id: 'https://openalex.org/fields/22' },
        subfield: { id: 'https://openalex.org/subfields/2207' },
        count: 80,
      },
    ],
  });

  mockFetch([
    { match: (u) => u.includes('/topics'), json: { results: [ROBOTICS_TOPIC] } },
    { match: (u) => u.includes('/works'), json: { results: [W_MATCH] } },
  ]);

  const res = await request(app)
    .post('/api/professor/A1/email-guide')
    .send({ skills: ['robotics'] });

  assert.equal(res.status, 200);
  assert.equal(res.body.matches.length, 1);
  assert.equal(res.body.matches[0].paperId, 'W_MATCH');
  assert.equal(res.body.matches[0].matchedTopic, 'Robotics');
  assert.equal(res.body.matches[0].matchedSource, 'skill');
});

// ─── 1c. matchedSource is 'field' when the winning target came from field ────
test('POST email-guide reports matchedSource:"field" when the declared field drives the match', async () => {
  // 'robotics' is the declared FIELD → resolves to the Robotics target → 'field'.
  const W_MATCH = work({
    id: 'W_MATCH',
    title: 'Adaptive Control for Legged Robots',
    year: 2022,
    date: '2022-03-15',
    citedBy: 120,
    topics: [
      {
        id: 'https://openalex.org/T100',
        display_name: 'Robotics',
        field: { id: 'https://openalex.org/fields/22' },
        subfield: { id: 'https://openalex.org/subfields/2207' },
        count: 80,
      },
    ],
  });

  mockFetch([
    { match: (u) => u.includes('/topics'), json: { results: [ROBOTICS_TOPIC] } },
    { match: (u) => u.includes('/works'), json: { results: [W_MATCH] } },
  ]);

  const res = await request(app)
    .post('/api/professor/A1/email-guide')
    .send({ field: 'robotics' });

  assert.equal(res.status, 200);
  assert.equal(res.body.matches.length, 1);
  assert.equal(res.body.matches[0].paperId, 'W_MATCH');
  assert.equal(res.body.matches[0].matchedTopic, 'Robotics');
  assert.equal(res.body.matches[0].matchedSource, 'field');
});

// ─── 2. Skill/accomplishment keyword overlap reorders papers ─────────────────
test('POST email-guide: an accomplishment/skill keyword overlap reorders the ranking', async () => {
  // Both papers share the SAME topic (so the topical portion is identical). They
  // differ only in title/abstract text. The student declares no resolvable
  // interest topic, but their skills + accomplishments mention "reinforcement"
  // and "quadruped" — which appear only in the OLDER paper. Text overlap must lift
  // that older paper above the newer one, proving skills/accomplishments count.
  const sharedTopic = {
    id: 'https://openalex.org/T100',
    display_name: 'Robotics',
    field: { id: 'https://openalex.org/fields/22' },
    subfield: { id: 'https://openalex.org/subfields/2207' },
    count: 50,
  };
  const W_NEWER = work({
    id: 'W_NEWER',
    title: 'Mapping for Wheeled Platforms',
    year: 2025,
    date: '2025-01-01',
    topics: [sharedTopic],
    abstract: 'We present a mapping pipeline for indoor wheeled navigation platforms.',
  });
  const W_OLDER = work({
    id: 'W_OLDER',
    title: 'Reinforcement Learning for Quadruped Locomotion',
    year: 2021,
    date: '2021-06-01',
    topics: [sharedTopic],
    abstract: 'A reinforcement policy trains a quadruped robot to walk over rough terrain.',
  });

  mockFetch([
    // No resolvable interest topic → resolveTopicId yields nothing usable.
    { match: (u) => u.includes('/topics'), json: { results: [] } },
    { match: (u) => u.includes('/works'), json: { results: [W_NEWER, W_OLDER] } },
  ]);

  const res = await request(app)
    .post('/api/professor/A1/email-guide')
    .send({
      skills: ['reinforcement learning'],
      accomplishments: ['Built a quadruped locomotion controller'],
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.matches.length, 2);
  assert.deepEqual(res.body.hook, res.body.matches[0]);
  assert.equal(res.body.hook.ranked, true);
  // The OLDER, keyword-overlapping paper outranks the NEWER one purely on text.
  assert.equal(res.body.matches[0].paperId, 'W_OLDER');
  assert.equal(res.body.matches[1].paperId, 'W_NEWER');
  // No interest topic resolved → the win was driven purely by text overlap, so
  // matchedTopic is null and matchedSource is null (not 'skill').
  assert.equal(res.body.matches[0].matchedTopic, null);
  assert.equal(res.body.matches[0].matchedSource, null);
});

// ─── 3. Fallback path: empty body → top-3 most-recent, ranked:false ──────────
test('POST email-guide with empty body falls back to the top-3 most-recent (ranked:false)', async () => {
  const W_OLD = work({ id: 'W_OLD', title: 'Old Work', year: 2019, date: '2019-01-01' });
  const W_MID = work({ id: 'W_MID', title: 'Mid Work', year: 2022, date: '2022-01-01' });
  const W_NEW = work({ id: 'W_NEW', title: 'Newest Work', year: 2025, date: '2025-02-10' });

  mockFetch([
    // No profile signal → no /topics call is needed, but guard anyway.
    { match: (u) => u.includes('/topics'), json: { results: [] } },
    // Returned out of order to prove the route sorts by date desc for the fallback.
    { match: (u) => u.includes('/works'), json: { results: [W_OLD, W_NEW, W_MID] } },
  ]);

  const res = await request(app).post('/api/professor/A1/email-guide').send({});

  assert.equal(res.status, 200);
  assert.equal(res.body.authorId, 'A1');
  assert.equal(res.body.matches.length, 3);
  assert.deepEqual(res.body.hook, res.body.matches[0]);
  // Most-recent first, ranked:false on every fallback item.
  assert.equal(res.body.matches[0].paperId, 'W_NEW');
  assert.equal(res.body.matches[1].paperId, 'W_MID');
  assert.equal(res.body.matches[2].paperId, 'W_OLD');
  assert.equal(res.body.hook.ranked, false);
  assert.equal(res.body.hook.matchedTopic, null);
  // Fallback matches carry no source bucket.
  assert.equal(res.body.hook.matchedSource, null);
  assert.ok(
    res.body.matches.every((m) => m.matchedSource === null),
    'every fallback match has matchedSource null'
  );
});

// ─── 4. 400: malformed body ──────────────────────────────────────────────────
test('POST email-guide returns 400 on a malformed body (JSON array)', async () => {
  // A JSON array body is not the expected object → 400 before any upstream call.
  const res = await request(app)
    .post('/api/professor/A1/email-guide')
    .set('Content-Type', 'application/json')
    .send('[1,2,3]');

  assert.equal(res.status, 400);
  assert.match(res.body.error, /Malformed body/);
});

// ─── 5. 502: upstream OpenAlex failure on the works fetch ────────────────────
test('POST email-guide returns 502 when the OpenAlex works fetch fails', async () => {
  mockFetch([
    // Topic resolution succeeds…
    { match: (u) => u.includes('/topics'), json: { results: [ROBOTICS_TOPIC] } },
    // …but the works fetch returns a hard error → oaFetch throws → outer catch 502.
    { match: (u) => u.includes('/works'), ok: false, status: 503 },
  ]);

  const res = await request(app)
    .post('/api/professor/A1/email-guide')
    .send({ interests: ['robotics'] });

  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'Failed to reach OpenAlex');
});

// ─── 6. No papers → { matches: [], hook: null } ──────────────────────────────
test('POST email-guide returns matches:[] and hook:null when the professor has no papers', async () => {
  mockFetch([
    { match: (u) => u.includes('/topics'), json: { results: [ROBOTICS_TOPIC] } },
    { match: (u) => u.includes('/works'), json: { results: [] } },
  ]);

  const res = await request(app)
    .post('/api/professor/A1/email-guide')
    .send({ interests: ['robotics'] });

  assert.equal(res.status, 200);
  assert.equal(res.body.authorId, 'A1');
  assert.deepEqual(res.body.matches, []);
  assert.equal(res.body.hook, null);
});
