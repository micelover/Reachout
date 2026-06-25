// Route + helper coverage for the REWRITTEN email-discovery engine:
//   GET /api/professor/:authorId/email  (DOI-keyed, all-fields fan-out)
//
// Every upstream (OpenAlex / Europe PMC / Unpaywall / ROR / landing-page HTML) is
// mocked by URL substring so these tests run fully offline, deterministically, and
// never touch the network or spend Anthropic tokens. The handler's contract under
// test (Layer 1 now: Europe PMC SEARCH-by-DOI for the pmcid, then NCBI efetch for
// the JATS full text — Europe PMC's own fullTextXML endpoint is no longer used):
//   • PMC <corresp> person-matched email (efetch JATS) → confidence:'verified'
//   • a PMC affiliation-only person-matched email       → confidence:'likely'
//   • landing-page mailto person-matched         → 'likely' (or 'verified' when a
//                                                   corresponding marker sits beside it)
//   • all probes empty + a resolvable inst domain → 'likely' / institution-pattern (mailable best-guess)
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
// and the NCBI-efetch JATS comes back as XML — a single hard-coded
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
      // A route may carry a real binary `buffer` (e.g. a hand-built PDF) so the
      // in-band OA-PDF probe path can be exercised fully offline. Default to empty.
      arrayBuffer: async () => {
        if (r.buffer) {
          const b = r.buffer;
          return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        }
        return new ArrayBuffer(0);
      },
    };
  };
}

// Build a tiny, valid single-page PDF whose page text is exactly `lines` (one
// content-stream line each). pdf-parse extracts this text losslessly offline, so a
// hand-built PDF lets us drive probePdf with NO network and NO real-PDF fixture file.
function buildPdf(lines) {
  const content = 'BT /F1 12 Tf 50 750 Td ' +
    lines.map((l, i) => `${i ? '0 -20 Td ' : ''}(${l}) Tj `).join('') + 'ET';
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
    '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>';
  objs[4] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
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
// `type:'article'` keeps it out of the SKIP_TYPES set, so the probe loop fires.
const WORKS_ONE_OA_DOI = {
  results: [{
    id: 'https://openalex.org/W1',
    doi: 'https://doi.org/10.1234/abc',
    type: 'article',
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

// ── 1. Verified via PMC <corresp> (EPMC search → pmcid → NCBI efetch JATS) ─────
test('email: PMC <corresp> person-matched email (NCBI efetch JATS) → confidence:verified, mailtoEnabled', async () => {
  mockFetch([
    authorRoute,
    worksRoute,
    rorRoute,
    // Layer 1 step A: Europe PMC SEARCH-by-DOI returns a hit carrying the pmcid.
    {
      match: (u) => u.includes('europepmc') && u.includes('/search'),
      json: { resultList: { result: [{ source: 'MED', id: 'PMC123', pmcid: 'PMC123', isOpenAccess: 'Y' }] } },
    },
    // Layer 1 step B: NCBI efetch (db=pmc, bare numeric id) returns the JATS XML.
    {
      match: (u) => u.includes('eutils.ncbi.nlm.nih.gov') && u.includes('efetch.fcgi'),
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

// ── 1b. Likely via PMC affiliation email (efetch JATS, NO <corresp>) ──────────
test('email: PMC affiliation-only email (no <corresp>) person-matched → confidence:likely, mailtoEnabled', async () => {
  mockFetch([
    authorRoute,
    worksRoute,
    rorRoute,
    {
      match: (u) => u.includes('europepmc') && u.includes('/search'),
      json: { resultList: { result: [{ source: 'MED', id: 'PMC123', pmcid: 'PMC123', isOpenAccess: 'Y' }] } },
    },
    // The efetch JATS carries the address inside an <aff> affiliation block only —
    // no <corresp>, so emailsFromPmcXml's structured pass misses it and the handler
    // falls back to extractEmails(xml) → graded `likely`.
    {
      match: (u) => u.includes('eutils.ncbi.nlm.nih.gov') && u.includes('efetch.fcgi'),
      contentType: 'application/xml',
      text: '<article><front><aff id="a1">Dept of CS, Stanford University. ' +
        'jane.smith@stanford.edu</aff></front></article>',
    },
  ]);

  const res = await request(app).get('/api/professor/A1/email');
  assert.equal(res.status, 200);
  assert.equal(res.body.email, 'jane.smith@stanford.edu');
  assert.equal(res.body.confidence, 'likely');
  assert.equal(res.body.mailtoEnabled, true);
  assert.match(res.body.source, /europepmc\.org\/article/);
});

// ── 1c. Probe selection: a supplementary-materials record is SKIPPED ──────────
test('email: a supplementary-materials work is skipped; only the real article DOI drives the verified hit', async () => {
  // Two OA+DOI works: a supplementary-materials record (SKIP_TYPES) and a real
  // article (with a PMC location → prioritized). Only the ARTICLE's DOI gets a
  // successful efetch email; the supplementary DOI, if it were probed, would 404
  // its search and produce nothing. Asserting a verified hit proves the article
  // was probed AND that the skipped record never short-circuited it.
  const PMC_SOURCE_ID = 'https://openalex.org/S4306400806';
  mockFetch([
    authorRoute,
    {
      match: (u) => u.includes('/works'),
      json: {
        results: [
          // Comes first in recency order but must be skipped outright.
          {
            id: 'https://openalex.org/W9',
            doi: 'https://doi.org/10.9999/supp',
            type: 'supplementary-materials',
            open_access: { is_oa: true },
            locations: [],
          },
          // The real article — carries a PMC location so it lands in pass 1.
          {
            id: 'https://openalex.org/W1',
            doi: 'https://doi.org/10.1234/abc',
            type: 'article',
            open_access: { is_oa: true },
            locations: [{ source: { id: PMC_SOURCE_ID } }],
          },
        ],
      },
    },
    rorRoute,
    // EPMC search: only the ARTICLE's DOI yields a pmcid hit. The supplementary
    // DOI's search returns an empty result list (so even if probed, it's a no-op).
    {
      match: (u) => u.includes('europepmc') && u.includes('/search') && u.includes('10.1234'),
      json: { resultList: { result: [{ source: 'MED', id: 'PMC123', pmcid: 'PMC123', isOpenAccess: 'Y' }] } },
    },
    {
      match: (u) => u.includes('europepmc') && u.includes('/search'),
      json: { resultList: { result: [] } },
    },
    {
      match: (u) => u.includes('eutils.ncbi.nlm.nih.gov') && u.includes('efetch.fcgi'),
      contentType: 'application/xml',
      text: '<article><corresp id="c1">Correspondence to <email>jane.smith@stanford.edu</email></corresp></article>',
    },
  ]);

  const res = await request(app).get('/api/professor/A1/email');
  assert.equal(res.status, 200);
  assert.equal(res.body.email, 'jane.smith@stanford.edu');
  assert.equal(res.body.confidence, 'verified');
  assert.equal(res.body.mailtoEnabled, true);
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

// ── 3. Institution-pattern best-guess via ROR domain (all paper probes empty) ──
test('email: all probes empty + ROR domain → confidence:likely, 4-pattern candidates, source:institution-pattern', async () => {
  mockFetch([
    authorRoute,
    { match: (u) => u.includes('/works'), json: { results: [] } }, // no probe DOIs at all
    rorRoute,
  ]);

  const res = await request(app).get('/api/professor/A1/email');
  assert.equal(res.status, 200);
  assert.equal(res.body.confidence, 'likely');
  assert.equal(res.body.source, 'institution-pattern');
  assert.equal(res.body.mailtoEnabled, true); // constructed best-guess is now mailable, flagged via source
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
test('email: a corresponding email belonging to a different-surname co-author is REJECTED (falls through to institution-pattern likely)', async () => {
  // The PMC <corresp> carries "bob.jones@stanford.edu" — same institution domain,
  // wrong surname. personMatch must reject it: a domain match alone never wins. The
  // handler then degrades to the institution-pattern guess, NOT the co-author email.
  mockFetch([
    authorRoute,
    worksRoute,
    rorRoute,
    {
      match: (u) => u.includes('europepmc') && u.includes('/search'),
      json: { resultList: { result: [{ source: 'MED', id: 'PMC123', pmcid: 'PMC123', isOpenAccess: 'Y' }] } },
    },
    {
      match: (u) => u.includes('eutils.ncbi.nlm.nih.gov') && u.includes('efetch.fcgi'),
      contentType: 'application/xml',
      text: '<article><corresp id="c1">Correspondence to <email>bob.jones@stanford.edu</email></corresp></article>',
    },
    { match: (u) => u.includes('unpaywall'), json: {} },
  ]);

  const res = await request(app).get('/api/professor/A1/email');
  assert.equal(res.status, 200);
  // The co-author's address must NOT be surfaced as the professor's email.
  assert.notEqual(res.body.email, 'bob.jones@stanford.edu');
  assert.equal(res.body.confidence, 'likely');
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

// ── 7. ORCID author-level verified (a PUBLIC ORCID email is authoritative) ─────
test('email: a surname-matched PUBLIC ORCID email → confidence:verified, mailtoEnabled, source orcid.org', async () => {
  // Author carries a full ORCID URL → probeOrcid runs once (author-level). To prove
  // ORCID is the winner and no earlier probe short-circuits it, works is EMPTY:
  //   • no OA+DOI works → no per-DOI probes (EPMC / landing / PDF / Crossref / arXiv)
  //   • probeAuthorPmc's own /works query also returns [] → no pmids → null
  // So ORCID's `verified` is the only hit, and it short-circuits raceForEmail.
  const orcidAuthor = { ...AUTHOR, orcid: 'https://orcid.org/0000-0002-1234-5678' };
  mockFetch([
    { match: (u) => /\/authors\/A1(\?|$)/.test(u), json: orcidAuthor },
    { match: (u) => u.includes('/works'), json: { results: [] } },
    rorRoute,
    // ORCID v3.0 email section: { email: [ { email, visibility } ] }. The API only
    // returns PUBLIC emails; the handler does not re-check visibility, it surname-gates.
    {
      match: (u) => u.includes('pub.orcid.org') && u.includes('0000-0002-1234-5678') && u.includes('/email'),
      json: { email: [{ email: 'jane.smith@stanford.edu', visibility: 'public' }] },
    },
  ]);

  const res = await request(app).get('/api/professor/A1/email');
  assert.equal(res.status, 200);
  assert.equal(res.body.email, 'jane.smith@stanford.edu');
  assert.equal(res.body.confidence, 'verified');
  assert.equal(res.body.mailtoEnabled, true);
  assert.match(res.body.source, /orcid\.org\/0000-0002-1234-5678/);
});

// ── 7b. ORCID gate: a different-surname public ORCID email is REJECTED ─────────
test('email: a wrong-surname PUBLIC ORCID email is rejected → falls through to institution-pattern', async () => {
  // ORCID returns a real public email but for the WRONG person (surname "Jones").
  // pickPersonEmail's personMatch gate must reject it, so probeOrcid yields null and
  // the route degrades to the institution-pattern best-guess (a domain is resolvable).
  const orcidAuthor = { ...AUTHOR, orcid: 'https://orcid.org/0000-0002-1234-5678' };
  mockFetch([
    { match: (u) => /\/authors\/A1(\?|$)/.test(u), json: orcidAuthor },
    { match: (u) => u.includes('/works'), json: { results: [] } },
    rorRoute,
    {
      match: (u) => u.includes('pub.orcid.org') && u.includes('/email'),
      json: { email: [{ email: 'bob.jones@stanford.edu', visibility: 'public' }] },
    },
  ]);

  const res = await request(app).get('/api/professor/A1/email');
  assert.equal(res.status, 200);
  assert.notEqual(res.body.email, 'bob.jones@stanford.edu');
  assert.equal(res.body.confidence, 'likely');
  assert.equal(res.body.source, 'institution-pattern');
  assert.equal(res.body.email, 'jane.smith@stanford.edu');
});

// ── 8. Crossref per-DOI likely (author metadata, even for paywalled papers) ────
test('email: a surname-matched Crossref author email → confidence:likely, source doi.org', async () => {
  // One OA+DOI work drives the per-DOI fan-out. Layer 1 (Europe PMC) is empty, the
  // Unpaywall landing page yields neither an email nor a pdfUrl (so the landing-page
  // AND in-band PDF probes are both no-ops), leaving Crossref as the winning hit.
  mockFetch([
    authorRoute,
    // Crossref BEFORE worksRoute: api.crossref.org/works/... also contains "/works",
    // and mockFetch is first-match — so the Crossref route must precede the OpenAlex
    // worksRoute or the latter would swallow it and return the wrong (works) JSON.
    {
      match: (u) => u.includes('api.crossref.org') && u.includes('/works/'),
      // crossrefFetch reads the body via res.text() + JSON.parse (size-capped), so the
      // mock must serve `text` (a real HTTP response exposes both .json() and .text();
      // this mock's .text() returns '' for json-only routes — see mockFetch).
      text: JSON.stringify({
        message: {
          author: [
            { given: 'Jane', family: 'Smith', email: 'jane.smith@stanford.edu' },
            { given: 'Bob', family: 'Jones' },
          ],
        },
      }),
    },
    worksRoute,
    rorRoute,
    epmcEmpty,
    // Unpaywall: no best_oa_location → probeLandingPage returns null (no email, no pdf).
    { match: (u) => u.includes('unpaywall'), json: {} },
  ]);

  const res = await request(app).get('/api/professor/A1/email');
  assert.equal(res.status, 200);
  assert.equal(res.body.email, 'jane.smith@stanford.edu');
  assert.equal(res.body.confidence, 'likely');
  assert.equal(res.body.mailtoEnabled, true);
  assert.match(res.body.source, /doi\.org\/10\.1234\/abc/);
});

// ── 8b. Crossref gate: an email mined from affiliation free-text JSON ──────────
test('email: a surname-matched email buried in a Crossref affiliation JSON string → likely', async () => {
  // No explicit a.email field — the address is embedded in the affiliation text.
  // probeCrossref mines email-shaped tokens out of JSON.stringify(authors), so this
  // surname-matched address is still recovered and graded `likely`.
  mockFetch([
    authorRoute,
    // Crossref BEFORE worksRoute (first-match ordering — see test above).
    {
      match: (u) => u.includes('api.crossref.org') && u.includes('/works/'),
      // crossrefFetch reads the body via res.text() + JSON.parse (size-capped) — serve
      // `text`, not `json` (mockFetch's .text() returns '' for json-only routes).
      text: JSON.stringify({
        message: {
          author: [
            {
              given: 'Jane',
              family: 'Smith',
              affiliation: [{ name: 'Dept of CS, Stanford University (jane.smith@stanford.edu)' }],
            },
          ],
        },
      }),
    },
    worksRoute,
    rorRoute,
    epmcEmpty,
    { match: (u) => u.includes('unpaywall'), json: {} },
  ]);

  const res = await request(app).get('/api/professor/A1/email');
  assert.equal(res.status, 200);
  assert.equal(res.body.email, 'jane.smith@stanford.edu');
  assert.equal(res.body.confidence, 'likely');
  assert.match(res.body.source, /doi\.org\/10\.1234\/abc/);
});

// ── 9. In-band OA-PDF probe — verified when a corresponding marker sits nearby ─
test('email: OA PDF with a "Corresponding author" marker near the email → confidence:verified', async () => {
  // probeLandingPage (Unpaywall best_oa_location.url_for_pdf) hands a pdfUrl to
  // probePdfCached → probePdf → fetchPdfBuffer → pdf-parse. The hand-built PDF's text
  // carries the email within ~200 chars of a "Corresponding" marker → verified.
  // EPMC empty + no landing-page email keeps the PDF probe as the deciding hit.
  const pdfBuf = buildPdf([
    'Corresponding author: Jane Smith',
    'Email: jane.smith@stanford.edu',
  ]);
  mockFetch([
    authorRoute,
    worksRoute,
    rorRoute,
    epmcEmpty,
    {
      match: (u) => u.includes('unpaywall'),
      json: { best_oa_location: { url_for_pdf: 'https://oa.example/paper.pdf' } },
    },
    {
      match: (u) => u.includes('oa.example') && u.includes('.pdf'),
      contentType: 'application/pdf',
      buffer: pdfBuf,
    },
    { match: (u) => u.includes('api.crossref.org'), text: JSON.stringify({ message: { author: [] } }) },
  ]);

  const res = await request(app).get('/api/professor/A1/email');
  assert.equal(res.status, 200);
  assert.equal(res.body.email, 'jane.smith@stanford.edu');
  assert.equal(res.body.confidence, 'verified');
  assert.equal(res.body.mailtoEnabled, true);
  assert.equal(res.body.source, 'https://oa.example/paper.pdf');
});

// ── 9b. In-band OA-PDF probe — likely when NO corresponding marker is present ──
test('email: OA PDF with a surname-matched email but no corresponding marker → confidence:likely', async () => {
  // Same path, but the PDF text has no correspondence marker near (or anywhere) the
  // email → probePdf grades it `likely`. Crossref returns nothing so the PDF wins.
  const pdfBuf = buildPdf([
    'Authors: Jane Smith, Bob Jones',
    'Contact: jane.smith@stanford.edu',
  ]);
  mockFetch([
    authorRoute,
    worksRoute,
    rorRoute,
    epmcEmpty,
    {
      match: (u) => u.includes('unpaywall'),
      json: { best_oa_location: { url_for_pdf: 'https://oa.example/paper.pdf' } },
    },
    {
      match: (u) => u.includes('oa.example') && u.includes('.pdf'),
      contentType: 'application/pdf',
      buffer: pdfBuf,
    },
    { match: (u) => u.includes('api.crossref.org'), text: JSON.stringify({ message: { author: [] } }) },
  ]);

  const res = await request(app).get('/api/professor/A1/email');
  assert.equal(res.status, 200);
  assert.equal(res.body.email, 'jane.smith@stanford.edu');
  assert.equal(res.body.confidence, 'likely');
  assert.equal(res.body.mailtoEnabled, true);
  assert.equal(res.body.source, 'https://oa.example/paper.pdf');
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
