// Tests for the co-author email disambiguation path. This is load-bearing for
// email correctness: a domain match ALONE must never win — the surname/name
// pattern is required so we don't hand a student a co-author's address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreEmailCandidates,
  rankEmailsByContext,
  personMatch,
  pickPersonEmail,
  guessEmails,
  cleanEmails,
  extractEmails,
  emailsFromPmcXml,
  emailsFromPubmedXml,
  pmcidFromPubmedChunk,
} from '../index.js';

const CTX = { first: 'jane', last: 'smith', domain: 'stanford.edu' };

// ─── scoreEmailCandidates ─────────────────────────────────────────────────────
test('scoreEmailCandidates ranks a surname+domain match highest', () => {
  const scored = scoreEmailCandidates(
    ['jsmith@stanford.edu', 'bob@stanford.edu', 'random@gmail.com'],
    CTX
  );
  assert.equal(scored[0].email, 'jsmith@stanford.edu');
  // surname 'smith' (+3) + first-initial 'j' (+1) + domain (+3) = 7
  assert.equal(scored[0].score, 7);
});

test('scoreEmailCandidates penalises generic mailboxes', () => {
  const scored = scoreEmailCandidates(['info@stanford.edu'], CTX);
  // domain (+3) - generic (-5) = -2
  assert.equal(scored[0].score, -2);
});

test('scoreEmailCandidates credits a subdomain of the institution domain', () => {
  const scored = scoreEmailCandidates(['jane.smith@cs.stanford.edu'], CTX);
  assert.ok(scored[0].score >= 6, `expected high score, got ${scored[0].score}`);
});

// ─── personMatch: the co-author guard ─────────────────────────────────────────
test('personMatch accepts the professor by surname', () => {
  assert.equal(personMatch('jsmith@stanford.edu', CTX), true);
  assert.equal(personMatch('smith@stanford.edu', CTX), true);
});

test('personMatch accepts first.last and firstlast and flast patterns', () => {
  assert.equal(personMatch('jane.smith@stanford.edu', CTX), true);
  assert.equal(personMatch('janesmith@stanford.edu', CTX), true);
  assert.equal(personMatch('jsmith@stanford.edu', CTX), true); // flast
});

test('personMatch REJECTS a co-author who merely shares the domain', () => {
  // Same institution, completely different name → must not be claimed as the prof.
  assert.equal(personMatch('bjones@stanford.edu', CTX), false);
  assert.equal(personMatch('alice.wong@stanford.edu', CTX), false);
});

test('personMatch ignores a too-short surname to avoid false substring hits', () => {
  // last name 'wu' is < 3 chars, so the surname-substring rule does not fire.
  const ctx = { first: 'li', last: 'wu' };
  assert.equal(personMatch('software@university.edu', ctx), false); // 'wu' not allowed to match
});

// ─── pickPersonEmail: scoring + the person guard together ─────────────────────
test('pickPersonEmail returns the prof-specific address, not the domain co-author', () => {
  const emails = ['bjones@stanford.edu', 'jane.smith@stanford.edu', 'lab@stanford.edu'];
  const picked = pickPersonEmail(emails, CTX);
  assert.equal(picked.email, 'jane.smith@stanford.edu');
});

test('pickPersonEmail returns null when only domain-sharing co-authors exist', () => {
  // Domain match alone is NOT enough — no name pattern → no confident pick.
  const emails = ['bjones@stanford.edu', 'info@stanford.edu'];
  assert.equal(pickPersonEmail(emails, CTX), null);
});

// ─── guessEmails: institution-pattern fallback ───────────────────────────────
test('guessEmails builds lowercased patterns from name + domain', () => {
  assert.deepEqual(guessEmails('Jane', 'Smith', 'stanford.edu'), [
    'jane.smith@stanford.edu',
    'jsmith@stanford.edu',
    'smith@stanford.edu',
    'janesmith@stanford.edu',
  ]);
});

test('guessEmails returns [] when any component is missing', () => {
  assert.deepEqual(guessEmails('', 'Smith', 'stanford.edu'), []);
  assert.deepEqual(guessEmails('Jane', 'Smith', ''), []);
});

// ─── cleanEmails + XML extraction ────────────────────────────────────────────
test('cleanEmails normalises, dedupes, strips mailto, and drops example addresses', () => {
  const out = cleanEmails([
    'mailto:Jane.Smith@Stanford.edu',
    'jane.smith@stanford.edu',        // dup after lowercasing
    'someone@example.com',            // example domain → dropped
    'trailing@stanford.edu).',        // trailing punctuation stripped
  ]);
  assert.deepEqual(out, ['jane.smith@stanford.edu', 'trailing@stanford.edu']);
});

test('emailsFromPmcXml pulls the structured corresponding-author email', () => {
  const xml = `<article><corresp id="c1">Correspondence to
    <email>jane.smith@stanford.edu</email></corresp></article>`;
  assert.deepEqual(emailsFromPmcXml(xml), ['jane.smith@stanford.edu']);
});

test('emailsFromPubmedXml pulls emails out of affiliation free text', () => {
  const xml = `<Affiliation>Dept of CS, Stanford. Electronic address: jane.smith@stanford.edu.</Affiliation>`;
  assert.deepEqual(emailsFromPubmedXml(xml), ['jane.smith@stanford.edu']);
});

// ─── extractEmails: de-obfuscation + list expansion (B1) ─────────────────────
test('extractEmails recovers plain addresses unchanged', () => {
  assert.deepEqual(extractEmails('write to jane.smith@stanford.edu today'),
    ['jane.smith@stanford.edu']);
});

test('extractEmails de-obfuscates BRACKETED (at)/[at]/{at} and (dot)/[dot] forms', () => {
  assert.deepEqual(extractEmails('john.smith{at}stanford.edu'), ['john.smith@stanford.edu']);
  assert.deepEqual(extractEmails('john [dot] smith [at] stanford [dot] edu'),
    ['john.smith@stanford.edu']);
});

test('extractEmails does NOT rewrite bare " at "/" dot " prose into an address', () => {
  // The classic false-positive: ordinary sentences must never fabricate a mailto.
  assert.deepEqual(extractEmails('look at stanford.edu for the program'), []);
  assert.deepEqual(extractEmails('email me at jane and visit example.edu later'), []);
  assert.deepEqual(extractEmails('Please look at the table and email the desk.'), []);
});

test('extractEmails expands bracketed lists (any count) and bare 2-author pairs', () => {
  assert.deepEqual(extractEmails('{jsmith, jdoe, abc}@stanford.edu'),
    ['jsmith@stanford.edu', 'jdoe@stanford.edu', 'abc@stanford.edu']);
  assert.deepEqual(extractEmails('a/b@mit.edu'), ['a@mit.edu', 'b@mit.edu']);
  // A 3+-token slash chain is a path, not a share — it must NOT fabricate a@/b@.
  const three = extractEmails('see src/a/b@mit.edu');
  assert.ok(!three.includes('a@mit.edu'), `should not fabricate a@: ${JSON.stringify(three)}`);
  assert.ok(!three.includes('src@mit.edu'), `should not fabricate src@: ${JSON.stringify(three)}`);
});

// ─── rankEmailsByContext: proximity ranking (B2) ─────────────────────────────
test('rankEmailsByContext promotes the email next to a corresponding-author marker', () => {
  const text =
    'Authors: Bob Jones, Jane Smith. Co-author bob.jones@stanford.edu is listed first. ' +
    '*Corresponding author. Jane Smith. jane.smith@stanford.edu';
  const ranked = rankEmailsByContext(
    text, ['bob.jones@stanford.edu', 'jane.smith@stanford.edu'], CTX);
  assert.equal(ranked[0], 'jane.smith@stanford.edu');
});

test('rankEmailsByContext returns email strings best-first and keeps generics last', () => {
  const text = 'jane.smith@stanford.edu corresponding. info@stanford.edu front office.';
  const ranked = rankEmailsByContext(
    text, ['info@stanford.edu', 'jane.smith@stanford.edu'], CTX);
  assert.equal(ranked[0], 'jane.smith@stanford.edu');
  assert.equal(ranked[ranked.length - 1], 'info@stanford.edu');
});

// ─── widened name matching: accents, hyphens, reversed order (B3) ────────────
test('personMatch folds accents so jose.smith matches "José Smith"', () => {
  assert.equal(personMatch('jose.smith@uni.edu', { first: 'José', last: 'Smith' }), true);
});

test('personMatch accepts a hyphenated-surname half ONLY with the FULL first name', () => {
  const ctx = { first: 'mary', last: 'smith-jones' };
  assert.equal(personMatch('mary.jones@uni.edu', ctx), true);   // full first + half
  assert.equal(personMatch('mary.smith@uni.edu', ctx), true);   // full first + half
  assert.equal(personMatch('msmithjones@uni.edu', ctx), true);  // flast on the WHOLE surname
  assert.equal(personMatch('smithjones@uni.edu', ctx), true);   // whole collapsed surname
});

test('personMatch REJECTS a co-author bearing one half of a hyphenated surname', () => {
  // "Bob Jones" must not be claimed as "Mary Smith-Jones" on the bare half alone…
  const ctx = { first: 'mary', last: 'smith-jones' };
  assert.equal(personMatch('bob.jones@uni.edu', ctx), false);
  assert.equal(personMatch('jones@uni.edu', ctx), false);       // bare half, no first signal
  // …nor when only the first INITIAL collides ("Adam Jones" shares the 'a').
  assert.equal(personMatch('ajones@uni.edu', { first: 'a', last: 'smith-jones' }), false);
  assert.equal(personMatch('msmith@uni.edu', ctx), false);      // initial + half is too weak
});

test('personMatch accepts reversed last.first ordering', () => {
  assert.equal(personMatch('smith.jane@stanford.edu', CTX), true);
});

test('personMatch still rejects a domain-sharing co-author after widening', () => {
  // The B3 widenings must NOT loosen the co-author guard.
  assert.equal(personMatch('bjones@stanford.edu', CTX), false);
  assert.equal(personMatch('alice.wong@stanford.edu', CTX), false);
});

// ─── pmcidFromPubmedChunk: PMCID harvest from PubMed efetch (A1) ──────────────
test('pmcidFromPubmedChunk harvests the linked PMCID from ArticleIdList', () => {
  const chunk = `<PubmedArticle><PMID>123</PMID><PubmedData><ArticleIdList>
    <ArticleId IdType="pubmed">123</ArticleId>
    <ArticleId IdType="pmc">PMC7654321</ArticleId>
  </ArticleIdList></PubmedData></PubmedArticle>`;
  assert.equal(pmcidFromPubmedChunk(chunk), '7654321');
});

test('pmcidFromPubmedChunk returns null when no PMCID is linked', () => {
  assert.equal(pmcidFromPubmedChunk('<PubmedArticle><PMID>123</PMID></PubmedArticle>'), null);
  assert.equal(pmcidFromPubmedChunk(null), null);
});
