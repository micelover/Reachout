// Unit tests for the pure, network-free helpers in index.js.
// These are deterministic and have the highest blast radius if they break.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reconstructAbstract,
  computeMatchScore,
  normalizeAuthor,
  normalizeWork,
  registrableDomain,
  isLatinName,
  isActiveAuthor,
} from '../index.js';

// ─── reconstructAbstract: inverted index → plain text ────────────────────────
test('reconstructAbstract orders words by position', () => {
  // Out-of-order positions are sorted back into reading order.
  const idx = {
    The: [0], quick: [1], brown: [2], fox: [3], jumps: [4],
    over: [5], the: [6], lazy: [7], dog: [8],
  };
  assert.equal(
    reconstructAbstract(idx),
    'The quick brown fox jumps over the lazy dog'
  );
});

test('reconstructAbstract drops a reconstruction <= 20 chars as noise', () => {
  // "Hello world" = 11 chars → below the > 20 floor → null.
  assert.equal(reconstructAbstract({ Hello: [0], world: [1] }), null);
});

test('reconstructAbstract handles repeated words at multiple positions', () => {
  const idx = {
    machine: [0, 5], learning: [1], improves: [2], over: [3],
    time: [4], deep: [6], models: [7],
  };
  assert.equal(
    reconstructAbstract(idx),
    'machine learning improves over time machine deep models'
  );
});

test('reconstructAbstract returns null for missing/invalid input', () => {
  assert.equal(reconstructAbstract(null), null);
  assert.equal(reconstructAbstract(undefined), null);
  assert.equal(reconstructAbstract('not an object'), null);
  assert.equal(reconstructAbstract({}), null); // empty → "" → < 20 chars
});

// ─── computeMatchScore: stays in the labeled heuristic range ─────────────────
test('computeMatchScore with no target falls back to prominence-only, clamped 50–97', () => {
  const withTopics = computeMatchScore([{ id: 'T1', count: 10 }], 1000, null);
  const noTopics = computeMatchScore([], 0, null);
  assert.ok(withTopics >= 50 && withTopics <= 97, `got ${withTopics}`);
  assert.ok(noTopics >= 50 && noTopics <= 97, `got ${noTopics}`);
  // Author with topics should score at least as high as one with none.
  assert.ok(withTopics >= noTopics);
});

test('computeMatchScore rewards a top-ranked, dominant matched topic', () => {
  const target = { topicId: 'T100', fieldId: 'F1', subfieldId: 'S1' };
  const topics = [
    { id: 'https://openalex.org/T100', count: 80, field: { id: 'https://openalex.org/F1' }, subfield: { id: 'https://openalex.org/S1' } },
    { id: 'https://openalex.org/T200', count: 20, field: { id: 'https://openalex.org/F1' }, subfield: { id: 'https://openalex.org/S2' } },
  ];
  const score = computeMatchScore(topics, 50000, target);
  assert.ok(score >= 50 && score <= 97, `score ${score} out of clamp range`);
  // A central topic + same-field overlap + cites should land well above the floor.
  assert.ok(score > 70, `expected a strong match > 70, got ${score}`);
});

test('computeMatchScore never exceeds the 97 ceiling even with huge citations', () => {
  const target = { topicId: 'T1', fieldId: 'F1', subfieldId: 'S1' };
  const topics = [{ id: 'https://openalex.org/T1', count: 1000, field: { id: 'https://openalex.org/F1' }, subfield: { id: 'https://openalex.org/S1' } }];
  assert.ok(computeMatchScore(topics, 10_000_000, target) <= 97);
});

test('computeMatchScore stays >= 50 when the target topic is absent from the author', () => {
  const target = { topicId: 'TZZZ', fieldId: 'F9', subfieldId: 'S9' };
  const topics = [{ id: 'https://openalex.org/T1', count: 5, field: { id: 'https://openalex.org/F1' } }];
  const score = computeMatchScore(topics, 10, target);
  assert.ok(score >= 50 && score <= 97, `got ${score}`);
});

// ─── normalizeAuthor: DTO shape + short-id stripping, fullId preserved ───────
test('normalizeAuthor strips the OpenAlex prefix into a short id but keeps fullId', () => {
  const raw = {
    id: 'https://openalex.org/A5045033578',
    display_name: 'Ada Lovelace',
    last_known_institutions: [{ display_name: 'Analytical Engine Lab', country_code: 'GB', type: 'education' }],
    topics: [{ display_name: 'Computing' }, { display_name: 'Mathematics' }],
    works_count: 42,
    cited_by_count: 9001,
    orcid: 'https://orcid.org/0000-0000-0000-0000',
  };
  const dto = normalizeAuthor(raw);
  assert.equal(dto.id, 'A5045033578');
  assert.equal(dto.fullId, 'https://openalex.org/A5045033578');
  assert.equal(dto.name, 'Ada Lovelace');
  assert.equal(dto.institution, 'Analytical Engine Lab');
  assert.equal(dto.country, 'GB');
  assert.equal(dto.institutionType, 'education');
  assert.deepEqual(dto.topics, ['Computing', 'Mathematics']);
  assert.equal(dto.worksCount, 42);
  assert.equal(dto.citedByCount, 9001);
  assert.ok(typeof dto.matchScore === 'number');
});

test('normalizeAuthor applies safe defaults for sparse records', () => {
  const dto = normalizeAuthor({ id: 'https://openalex.org/A1' });
  assert.equal(dto.id, 'A1');
  assert.equal(dto.name, 'Unknown');
  assert.equal(dto.institution, 'Independent');
  assert.equal(dto.country, '');
  assert.deepEqual(dto.topics, []);
  assert.equal(dto.worksCount, 0);
  assert.equal(dto.citedByCount, 0);
  assert.equal(dto.orcid, null);
});

test('normalizeAuthor caps surfaced topics at 4', () => {
  const dto = normalizeAuthor({
    id: 'https://openalex.org/A1',
    topics: [1, 2, 3, 4, 5, 6].map((n) => ({ display_name: `Topic ${n}` })),
  });
  assert.equal(dto.topics.length, 4);
});

// ─── normalizeWork: DTO shape + short-id + abstract reconstruction ───────────
test('normalizeWork maps fields and reconstructs the abstract', () => {
  const dto = normalizeWork({
    id: 'https://openalex.org/W123',
    title: 'On Computable Numbers',
    publication_year: 1936,
    primary_location: { source: { display_name: 'Proc. London Math. Soc.' } },
    cited_by_count: 12345,
    // Note: a single word may legitimately repeat at multiple positions, but each
    // distinct word is its own key (no duplicate object keys).
    abstract_inverted_index: {
      An: [0], application: [1], of: [2], theory: [3], to: [4],
      the: [5, 7], Entscheidungsproblem: [6], halting: [8], problem: [9],
    },
  });
  assert.equal(dto.id, 'W123');
  assert.equal(dto.title, 'On Computable Numbers');
  assert.equal(dto.year, 1936);
  assert.equal(dto.venue, 'Proc. London Math. Soc.');
  assert.equal(dto.citedByCount, 12345);
  assert.equal(
    dto.abstract,
    'An application of theory to the Entscheidungsproblem the halting problem'
  );
});

test('normalizeWork defaults missing fields and null abstract', () => {
  const dto = normalizeWork({ id: 'https://openalex.org/W9' });
  assert.equal(dto.id, 'W9');
  assert.equal(dto.title, 'Untitled');
  assert.equal(dto.year, null);
  assert.equal(dto.venue, null);
  assert.equal(dto.citedByCount, 0);
  assert.equal(dto.abstract, null);
});

// ─── registrableDomain: compound-TLD handling ────────────────────────────────
test('registrableDomain handles plain two-label domains', () => {
  assert.equal(registrableDomain('https://stanford.edu'), 'stanford.edu');
  assert.equal(registrableDomain('https://www.mit.edu/faculty'), 'mit.edu');
});

test('registrableDomain handles compound ac.uk / edu.au TLDs', () => {
  assert.equal(registrableDomain('https://www.cam.ac.uk/'), 'cam.ac.uk');
  assert.equal(registrableDomain('http://cs.ox.ac.uk/people'), 'ox.ac.uk');
  assert.equal(registrableDomain('https://unimelb.edu.au'), 'unimelb.edu.au');
  assert.equal(registrableDomain('https://www.sydney.edu.au/research'), 'sydney.edu.au');
});

test('registrableDomain reduces deep subdomains to the registrable pair', () => {
  assert.equal(registrableDomain('https://lab.cs.berkeley.edu'), 'berkeley.edu');
});

test('registrableDomain returns null for falsy or unparsable input', () => {
  assert.equal(registrableDomain(null), null);
  assert.equal(registrableDomain(''), null);
  assert.equal(registrableDomain('not a url'), null);
});

// ─── isLatinName: keep Latin (incl. diacritics), drop other scripts ──────────
test('isLatinName keeps Latin names including diacritics, hyphens, apostrophes', () => {
  for (const name of [
    'John Smith', 'José García', 'Müller', 'Łukasz Kowalski',
    'Søren Kierkegaard', "O'Brien", 'Jean-Pierre',
  ]) {
    assert.equal(isLatinName(name), true, name);
  }
});

test('isLatinName drops names in non-Latin scripts', () => {
  for (const name of [
    'Даниела Йорданова', // Cyrillic
    '李四', '王伟',        // Han
    'محمد',               // Arabic
    'Γεώργιος',           // Greek
    '李 Wang',            // mixed: contains Han → dropped
  ]) {
    assert.equal(isLatinName(name), false, name);
  }
});

test('isLatinName drops empty, whitespace-only, and punctuation-only names', () => {
  assert.equal(isLatinName(''), false);
  assert.equal(isLatinName('  '), false);
  assert.equal(isLatinName('—'), false);
});

// ─── isActiveAuthor: drop retired/emeritus/deceased (no recent ACTUAL works) ──
// Year is built dynamically so the suite never goes stale as calendars roll over.
const THIS_YEAR = new Date().getFullYear();
const yr = (year, works_count, cited_by_count = 0) => ({ year, works_count, cited_by_count });

test('isActiveAuthor keeps an author with works_count>0 in the last couple of years', () => {
  const raw = { counts_by_year: [
    yr(THIS_YEAR, 3, 40),
    yr(THIS_YEAR - 1, 5, 30),
    yr(THIS_YEAR - 2, 4, 20),
  ] };
  assert.equal(isActiveAuthor(raw), true);
});

test('isActiveAuthor drops the dead-but-still-cited case (recent years works_count:0, cited_by_count>0)', () => {
  // Long-dead author: citations to old work still accrue, but no new works.
  const raw = { counts_by_year: [
    yr(THIS_YEAR, 0, 120),
    yr(THIS_YEAR - 1, 0, 150),
    yr(THIS_YEAR - 2, 0, 90),
  ] };
  assert.equal(isActiveAuthor(raw), false);
});

test('isActiveAuthor drops an author whose newest works_count>0 year is 12 years ago', () => {
  const raw = { counts_by_year: [
    yr(THIS_YEAR, 0, 10),
    yr(THIS_YEAR - 12, 6, 200),
  ] };
  assert.equal(isActiveAuthor(raw), false);
});

test('isActiveAuthor drops an author with empty or missing counts_by_year', () => {
  assert.equal(isActiveAuthor({ counts_by_year: [] }), false);
  assert.equal(isActiveAuthor({}), false);
  assert.equal(isActiveAuthor(null), false);
});

test('isActiveAuthor keeps the boundary year (currentYear - 6) and drops just past it (currentYear - 7)', () => {
  assert.equal(isActiveAuthor({ counts_by_year: [yr(THIS_YEAR - 6, 2, 5)] }), true);
  assert.equal(isActiveAuthor({ counts_by_year: [yr(THIS_YEAR - 7, 2, 5)] }), false);
});
