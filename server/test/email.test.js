// Route + helper coverage for the REWRITTEN email-discovery engine:
//   GET /api/professor/:authorId/email  (DOI-keyed, all-fields fan-out)
//
// Every upstream (OpenAlex / Europe PMC / Unpaywall / ROR / landing-page HTML) is
// mocked by URL substring so these tests run fully offline, deterministically, and
// never touch the network or spend Anthropic tokens. The handler's contract under
// test (see index.js ~2753-2929):
//   • Europe PMC <corresp> person-matched email → confidence:'verified'
//   • landing-page mailto person-matched         → 'likely' (or 'verified' when a
//                                                   corresponding marker sits beside it)
//   • all probes empty + a resolvable inst domain → 'guess' / institution-pattern
//   • a co-author's email (wrong surname) is REJECTED by personMatch
//   • the route NEVER errors — always 200 with at least the partial payload
//   • a cached (incl. negative) hit returns instantly, no upstream calls
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app, cacheClear, cacheSet, emailsFromHtml } from '../index.js';

const realFetch = global.fetch;

beforeEach(() => {
  // The email cache is durable (async) — cacheClear() wipes the in-memory Map that
  // backs it when no Firebase creds are present (the test-safe default).
  cacheClear();
});

afterEach(() => {
  global.fetch = realFetch;
});

// URL-matching fetch stub. Unlike the routes.test.js version this one supports a
// per-route `contentType`, because the new handler's fetchHtml requires `text/html`
// and Europe PMC's fullTextXML comes back as XML — a single hard-coded
// `application/json` content-type would make those tiers silently no-op.
function mockFetch(routes) {
  global.fetch = async (url) => {
    const u = String(url);
    const r = routes.find((x) => x.match(u));
    if (!r) {
      return {
        ok: false, status: 404,
        headers: { get: () => 'application/json' },
        body: null,
        json: async () => ({}), text: async () => '',
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    return {
      ok: r.ok !== undefined ? r.ok : true,
      status: r.status || 200,
      headers: { get: () => r.contentType || 'application/json' },
      body: null, // forces fetchHtml down its non-streaming res.text() branch
      json: async () => r.json ?? {},
      text: async () => r.text ?? '',
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
}

// ── Shared fixtures ───────────────────────────────────────────────────────────
// Author "Jane Smith" at Stanford (a sustained affiliation, so primaryInstitution
// picks it over last_known). A ror id lets resolveInstitutionDomain hit the ROR
// mock for the institution domain.
const AUTHOR = {
  id: 'https://openalex.org/A1',
  display_name: 'Jane Smith',
  affiliations: [{
    institution: {
      id: 'https://openalex.org/I1',
      display_name: 'Stanford University',
      type: 'education',
      ror: 'https://ror.org/00f54p054',
    },
    years: [2023, 2022, 2021],
  }],
  last_known_institutions: [{ id: 'https://openalex.org/I1', display_name: 'Stanford University' }],
};

// One recent open-access work carrying a DOI → exactly one probe DOI.
const WORKS_ONE_OA_DOI = {
  results: [{
    id: 'https://openalex.org/W1',
    doi: 'https://doi.org/10.1234/abc',
    open_access: { is_oa: true },
    locations: [],
  }],
};

const authorRoute = { match: (u) => /\/authors\/A1(\?|$)/.test(u), json: AUTHOR };
const worksRoute = { match: (u) => u.includes('/works'), json: WORKS_ONE_OA_DOI };
const rorRoute = { match: (u) => u.includes('ror.org'), json: { domains: ['stanford.edu'] } };
const epmcEmpty = {
  match: (u) => u.includes('europepmc') && u.includes('/search'),
  json: { resultList: { result: [] } },
};

// ── 1. Verified via Europe PMC <corresp> ──────────────────────────────────────
test('email: Europe PMC <corresp> person-matched email → confidence:verified, mailtoEnabled', async () => {
  mockFetch([
    authorRoute,
    worksRoute,
    rorRoute,
    {
      match: (u) => u.includes('europepmc') && u.includes('/search'),
      json: { resultList: { result: [{ source: 'PMC', id: 'PMC123', pmcid: 'PMC123', isOpenAccess: 'Y' }] } },
    },
    {
      match: (u) => u.includes('europepmc') && u.includes('fullTextXML'),
      contentType: 'application/xml',
      text: '<article><corresp id="c1">Correspondence to <email>jane.smith@stanford.edu</email></corresp></article>',
    },
  ]);

  const res = await request(app).get('/api/professor/A1/email');
  assert.equal(res.status, 200);
  assert.equal(res.body.email, 'jane.smith@stanford.edu');
  assert.equal(res.body.confidence, 'verified');
  assert.equal(res.body.mailtoEnabled, true);
  // Source points at the Europe PMC article, not the institution pattern.
  assert.match(res.body.source, /europepmc\.org\/article/);
});

// ── 2a. Likely via landing-page mailto (no corresponding marker) ──────────────
test('email: Unpaywall landing-page mailto person-matched → confidence:likely, mailtoEnabled', async () => {
  mockFetch([
    authorRoute,
    worksRoute,
    rorRoute,
    epmcEmpty,
    {
      match: (u) => u.includes('unpaywall'),
      json: { best_oa_location: { url_for_landing_page: 'https://journal.example/article/abc' } },
    },
    {
      match: (u) => u.includes('journal.example'),
      contentType: 'text/html',
      text: '<html><body><p>Authors: Jane Smith</p>' +
        '<a href="mailto:jane.smith@stanford.edu">email the author</a></body></html>',
    },
  ]);

  const res = await request(app).get('/api/professor/A1/email');
  assert.equal(res.status, 200);
  assert.equal(res.body.email, 'jane.smith@stanford.edu');
  // No "corresponding" marker beside the address → handler grades it `likely`.
  assert.equal(res.body.confidence, 'likely');
  assert.equal(res.body.mailtoEnabled, true);
  assert.equal(res.body.source, 'https://journal.example/article/abc');
});

// ── 2b. Verified via landing page WITH a corresponding marker beside the email ─
test('email: landing-page mailto next to a "Corresponding author" marker → verified', async () => {
  mockFetch([
    authorRoute,
    worksRoute,
    rorRoute,
    epmcEmpty,
    {
      match: (u) => u.includes('unpaywall'),
      json: { best_oa_location: { url_for_landing_page: 'https://journal.example/article/abc' } },
    },
    {
      match: (u) => u.includes('journal.example'),
      contentType: 'text/html',
      text: '<html><body><p>Corresponding author: Jane Smith, ' +
        '<a href="mailto:jane.smith@stanford.edu">jane.smith@stanford.edu</a></p></body></html>',
    },
  ]);

  const res = await request(app).get('/api/professor/A1/email');
  assert.equal(res.status, 200);
  assert.equal(res.body.email, 'jane.smith@stanford.edu');
  assert.equal(res.body.confidence, 'verified');
  assert.equal(res.body.mailtoEnabled, true);
});

// ── 3. Guess via ROR institution domain (all paper probes empty) ──────────────
test('email: all probes empty + ROR domain → confidence:guess, 4-pattern candidates, source:institution-pattern', async () => {
  mockFetch([
    authorRoute,
    { match: (u) => u.includes('/works'), json: { results: [] } }, // no probe DOIs at all
    rorRoute,
  ]);

  const res = await request(app).get('/api/professor/A1/email');
  assert.equal(res.status, 200);
  assert.equal(res.body.confidence, 'guess');
  assert.equal(res.body.source, 'institution-pattern');
  assert.equal(res.body.mailtoEnabled, false); // a guess is display-only, never a mailto
  // email is the FIRST guess; candidates is the full 4-pattern list.
  assert.equal(res.body.email, 'jane.smith@stanford.edu');
  assert.deepEqual(res.body.candidates, [
    'jane.smith@stanford.edu',
    'jsmith@stanford.edu',
    'smith@stanford.edu',
    'janesmith@stanford.edu',
  ]);
});

// ── 4a. Author resolves but nothing else → 200, email:null, facultySearchUrl set ─
test('email: author resolves but no email anywhere and no domain → 200 with email:null and a facultySearchUrl', async () => {
  // Works empty AND no domain resolvable (no ror, /institutions/I1 404s) → there is
  // no guess to make. The route still degrades to a usable faculty-search link.
  mockFetch([
    authorRoute,
    { match: (u) => u.includes('/works'), json: { results: [] } },
    // no ror route, no /institutions match → resolveInstitutionDomain yields null
  ]);

  const res = await request(app).get('/api/professor/A1/email');
  assert.equal(res.status, 200);
  assert.equal(res.body.email, null);
  assert.equal(res.body.confidence, null);
  assert.equal(res.body.mailtoEnabled, false);
  assert.ok(res.body.facultySearchUrl, 'a faculty-search link is still returned');
  assert.match(res.body.facultySearchUrl, /Jane%20Smith/);
});

// ── 4b. Hard total failure (every fetch throws) still returns 200 ─────────────
test('email: every upstream throws → route never errors, returns 200 with email:null', async () => {
  // The author fetch itself throws, so the outer catch returns the bare partial
  // payload. NOTE: facultySearchUrl is null here — it is only built AFTER the author
  // record resolves, so a failure at the very first fetch leaves it unset. The
  // route-never-errors invariant (always 200) is what matters.
  global.fetch = async () => { throw new Error('total upstream failure'); };

  const res = await request(app).get('/api/professor/A2/email');
  assert.equal(res.status, 200);
  assert.equal(res.body.email, null);
  assert.equal(res.body.confidence, null);
  assert.equal(res.body.mailtoEnabled, false);
  assert.ok('candidates' in res.body);
  assert.ok('facultySearchUrl' in res.body);
});

// ── 5. personMatch gate: a DIFFERENT-surname co-author email is REJECTED ──────
test('email: a corresponding email belonging to a different-surname co-author is REJECTED (falls through to guess)', async () => {
  // The PMC <corresp> carries "bob.jones@stanford.edu" — same institution domain,
  // wrong surname. personMatch must reject it: a domain match alone never wins. The
  // handler then degrades to the institution-pattern guess, NOT the co-author email.
  mockFetch([
    authorRoute,
    worksRoute,
    rorRoute,
    {
      match: (u) => u.includes('europepmc') && u.includes('/search'),
      json: { resultList: { result: [{ source: 'PMC', id: 'PMC123', pmcid: 'PMC123', isOpenAccess: 'Y' }] } },
    },
    {
      match: (u) => u.includes('europepmc') && u.includes('fullTextXML'),
      contentType: 'application/xml',
      text: '<article><corresp id="c1">Correspondence to <email>bob.jones@stanford.edu</email></corresp></article>',
    },
    { match: (u) => u.includes('unpaywall'), json: {} },
  ]);

  const res = await request(app).get('/api/professor/A1/email');
  assert.equal(res.status, 200);
  // The co-author's address must NOT be surfaced as the professor's email.
  assert.notEqual(res.body.email, 'bob.jones@stanford.edu');
  assert.equal(res.body.confidence, 'guess');
  assert.equal(res.body.source, 'institution-pattern');
  assert.equal(res.body.email, 'jane.smith@stanford.edu');
});

// ── 6. Cache fast path: a pre-seeded (negative) hit short-circuits all upstreams ─
test('email: a cached negative payload returns instantly without calling any upstream', async () => {
  const negative = {
    email: null,
    confidence: null,
    source: null,
    mailtoEnabled: false,
    facultySearchUrl: 'https://www.google.com/search?q=seeded',
    candidates: [],
  };
  // The email cache is async now — must use cacheSet, not cache.set.
  await cacheSet('email:A1', negative, 60_000);

  // Any fetch after the cache hit is a bug: this spy fails the test if reached.
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls++; throw new Error('upstream must not be hit on a cache hit'); };

  const res = await request(app).get('/api/professor/A1/email');
  assert.equal(res.status, 200);
  assert.equal(fetchCalls, 0, 'no upstream fetch should occur on a cache hit');
  assert.deepEqual(res.body, negative);
});

// ── emailsFromHtml — the new pure mailto/de-obfuscation extractor ─────────────
test('emailsFromHtml extracts and lowercases a mailto: href target', () => {
  assert.deepEqual(
    emailsFromHtml('<a href="mailto:Jane.Smith@Stanford.edu">contact</a>'),
    ['jane.smith@stanford.edu'],
  );
});

test('emailsFromHtml recovers an address from de-tagged body text', () => {
  assert.deepEqual(
    emailsFromHtml('<p>Reach the author at jane.smith@stanford.edu today.</p>'),
    ['jane.smith@stanford.edu'],
  );
});

test('emailsFromHtml decodes HTML numeric entities (&#64; → @)', () => {
  assert.deepEqual(
    emailsFromHtml('<p>jane.smith&#64;stanford.edu</p>'),
    ['jane.smith@stanford.edu'],
  );
});

test('emailsFromHtml ignores addresses inside <script> blocks', () => {
  // An analytics/JSON blob in a <script> must not leak a fabricated address.
  assert.deepEqual(
    emailsFromHtml('<script>var x="tracker@evil.com";</script>' +
      '<a href="mailto:real@stanford.edu">email</a>'),
    ['real@stanford.edu'],
  );
});

test('emailsFromHtml de-obfuscates bracketed [at]/[dot] forms in body text', () => {
  assert.deepEqual(
    emailsFromHtml('<p>john.smith [at] stanford [dot] edu</p>'),
    ['john.smith@stanford.edu'],
  );
});

test('emailsFromHtml returns [] for empty / null input', () => {
  assert.deepEqual(emailsFromHtml(''), []);
  assert.deepEqual(emailsFromHtml(null), []);
});
