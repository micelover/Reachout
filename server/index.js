/**
 * ReachOut — Professor Discovery Engine
 * Lightweight Express proxy over the OpenAlex API (free, no key).
 *
 * Port: 8787
 * All OpenAlex calls use the "polite pool" (mailto param) for better rate limits.
 *
 * Endpoints:
 *   GET  /api/health
 *   GET  /api/discover?field=<text>&page=1&per_page=12
 *   GET  /api/professor/:authorId
 *   GET  /api/professor/:authorId/papers
 *   GET  /api/professor/:authorId/email
 *   POST /api/analyze-resume  (requires ANTHROPIC_API_KEY env var)
 */

import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { PDFParse } from 'pdf-parse';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 8787;
const OPENALEX = 'https://api.openalex.org';
const MAILTO = 'reachout-app@example.com';

// ─── In-memory cache (10-min TTL) ────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

async function oaFetch(path) {
  const url = `${OPENALEX}${path}${path.includes('?') ? '&' : '?'}mailto=${MAILTO}`;
  const cached = cache.get(url);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'ReachOut/1.0 (mailto:reachout-app@example.com)' },
  });
  if (!res.ok) throw new Error(`OpenAlex ${res.status}: ${path}`);
  const data = await res.json();
  cache.set(url, { data, ts: Date.now() });
  return data;
}

// ─── Body parsing ────────────────────────────────────────────────────────────
// Base64-encoded resume images inflate ~33%, so 15 MB covers ~10 MB source files.
app.use(express.json({ limit: '15mb' }));

// ─── CORS (allow file:// and any localhost origin for dev) ───────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const stripId = (v) => (v ? String(v).replace('https://openalex.org/', '') : null);

/**
 * Fetch OpenAlex topic candidates for a free-text field, in RELEVANCE order.
 * Returns [{ id, fullId, name, fieldId, fieldName, subfieldId }] (short ids; null-safe).
 * Cached via oaFetch. OpenAlex topics are hyper-granular and domain-qualified
 * (e.g. "Machine Learning in Materials Science"), so callers use the full list to
 * reason about which domain a field belongs to rather than blindly taking #1.
 */
async function fetchTopicCandidates(field) {
  const data = await oaFetch(`/topics?search=${encodeURIComponent(field)}&per_page=8`);
  const results = data.results || [];
  return results.map((t) => ({
    id: stripId(t.id),
    fullId: t.id,
    name: t.display_name,
    fieldId: stripId(t.field?.id),       // e.g. "fields/17"; may be null
    fieldName: t.field?.display_name || null,
    subfieldId: stripId(t.subfield?.id),
  }));
}

/**
 * Resolve a free-text field name → best matching OpenAlex topic.
 *
 * OpenAlex `/topics?search=` is already relevance-ranked, so we DON'T re-sort by
 * works_count (that grabbed the broadest topic, not the most relevant one).
 *
 * If `preferredFieldId` is supplied (the résumé's inferred dominant field), we pick
 * the highest-relevance candidate that sits in that field — this keeps a generic
 * interest like "machine learning" inside Computer Science instead of drifting to
 * "Machine Learning in Materials Science". With no preferred field (or no candidate
 * in it), we fall back to OpenAlex's #1, gently preferring a display_name match.
 */
async function resolveTopicId(field, preferredFieldId = null) {
  const candidates = await fetchTopicCandidates(field);
  if (!candidates.length) return null;

  let best = null;
  if (preferredFieldId) {
    // Candidates are already relevance-ordered, so the first in-field one wins.
    best = candidates.find((c) => c.fieldId === preferredFieldId) || null;
  }
  if (!best) {
    const q = field.trim().toLowerCase();
    best =
      candidates.find((c) => (c.name || '').toLowerCase().includes(q)) || candidates[0];
  }

  return {
    id: best.id,
    fullId: best.fullId,
    name: best.name,
    fieldId: best.fieldId,
    subfieldId: best.subfieldId,
  };
}

/**
 * Infer the résumé's dominant academic field from its interests collectively.
 *
 * For each interest we fetch its topic candidates and tally a harmonic-weighted
 * frequency per fieldId across ALL interests: every candidate at rank r adds
 * 1/(r+1) to its field. This is RELEVANCE-rank weighting — not works_count — so a
 * huge but off-topic field can't dominate by size, and the field that *pervades*
 * the candidate space (many on-theme topics across interests) wins over one that
 * merely sneaks a single high-relevance topic into each interest.
 *
 * Example: for ["artificial intelligence research","data-driven decision making",
 * "web development"], Computer Science appears across many candidates (AI + web) and
 * wins, even though a Decision-Sciences topic ranks #0 for one interest.
 *
 * Returns the winning short fieldId (e.g. "fields/17"), or null.
 */
async function pickDominantField(interests) {
  const lists = await Promise.all(
    (interests || []).map((i) => fetchTopicCandidates(i).catch(() => []))
  );

  const tally = new Map(); // fieldId → harmonic-weighted frequency
  for (const candidates of lists) {
    candidates.forEach((c, rank) => {
      if (!c.fieldId) return;
      tally.set(c.fieldId, (tally.get(c.fieldId) || 0) + 1 / (rank + 1));
    });
  }

  let winner = null;
  let best = 0;
  for (const [fieldId, weight] of tally) {
    if (weight > best) {
      best = weight;
      winner = fieldId;
    }
  }
  return winner;
}

/** Reconstruct abstract text from OpenAlex inverted index format. */
function reconstructAbstract(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== 'object') return null;
  try {
    const positions = [];
    for (const [word, idxList] of Object.entries(invertedIndex)) {
      for (const pos of idxList) positions.push({ pos, word });
    }
    positions.sort((a, b) => a.pos - b.pos);
    const text = positions.map((p) => p.word).join(' ');
    return text.length > 20 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Real topic-overlap match score (≈50–97) for how well an author fits a target
 * interest. This is still a display heuristic, NOT an OpenAlex metric — but it
 * now reflects genuine topical fit instead of pure citation rank.
 *
 * Inputs:
 *   rawTopics - the author's OpenAlex topics[] (each { id, count, field, subfield }),
 *               ordered by count desc.
 *   citedBy   - author cited_by_count, used only as a gentle tiebreaker.
 *   target    - { topicId, fieldId, subfieldId } from resolveTopicId (short ids).
 *
 * Components:
 *   • Topic prominence (0–30): how high the matched topic ranks in this author's
 *     work and what share of their output it represents.
 *   • Field/subfield overlap (0–9): how many of the author's top topics sit in the
 *     same field/subfield — catches adjacent, on-theme work.
 *   • Citation tiebreaker (0–5): a log factor so it only nudges ties.
 * Clamped to 50–97, leaving headroom for the multi-interest bonus to reach 99.
 *
 * Falls back gracefully to a prominence-only estimate when `target` is absent.
 */
function computeMatchScore(rawTopics, citedBy, target) {
  const topics = Array.isArray(rawTopics) ? rawTopics : [];
  const strip = (v) => (v ? String(v).replace('https://openalex.org/', '') : null);

  // Citation tiebreaker (0–5), gentle log scale.
  const citeBonus = Math.min(5, Math.round(Math.log10((citedBy || 0) + 10) - 1));

  // No target → prominence-only fallback (e.g. the plain /api/discover route).
  if (!target || !target.topicId) {
    const base = topics.length ? 70 : 60;
    return Math.min(97, Math.max(50, base + citeBonus));
  }

  const totalCount = topics.reduce((s, t) => s + (t.count || 0), 0) || 1;
  const matchIdx = topics.findIndex((t) => strip(t.id) === target.topicId);
  const matched = matchIdx >= 0 ? topics[matchIdx] : null;

  // Topic prominence (0–30): rank component (rank 0 → 18, fading out by rank ~6)
  // plus a share component (matched topic's fraction of the author's output → 0–12).
  let prominence;
  if (matched) {
    const rankPart = Math.max(0, 18 - matchIdx * 3);
    const sharePart = Math.round(((matched.count || 0) / totalCount) * 12);
    prominence = rankPart + sharePart;
  } else {
    prominence = 6; // topic not in list (shouldn't happen post-filter) → small floor
  }

  // Field/subfield overlap (0–9): how many of the author's top 6 topics share the
  // target field or subfield — rewards a coherent, on-theme profile.
  let overlap = 0;
  for (const t of topics.slice(0, 6)) {
    const sameSub = target.subfieldId && strip(t.subfield?.id) === target.subfieldId;
    const sameField = target.fieldId && strip(t.field?.id) === target.fieldId;
    if (sameSub) overlap += 2;
    else if (sameField) overlap += 1;
  }
  overlap = Math.min(9, overlap);

  const score = 50 + prominence + overlap + citeBonus;
  return Math.min(97, Math.max(50, score));
}

/**
 * Normalize a raw OpenAlex author record → card/profile DTO.
 * Pass `target` ({ topicId, fieldId, subfieldId }) to score topical fit to a
 * specific interest; omit it for the plain citation-ordered discover route.
 */
function normalizeAuthor(raw, target = null) {
  const institutions = raw.last_known_institutions || [];
  const primaryInst = institutions[0] || {};
  const rawTopics = raw.topics || [];
  const topics = rawTopics.slice(0, 4).map((t) => t.display_name);
  const shortId = (raw.id || '').replace('https://openalex.org/', '');

  return {
    id: shortId,
    fullId: raw.id,
    name: raw.display_name || 'Unknown',
    institution: primaryInst.display_name || 'Independent',
    country: primaryInst.country_code || '',
    institutionType: primaryInst.type || '',
    topics,
    worksCount: raw.works_count || 0,
    citedByCount: raw.cited_by_count || 0,
    orcid: raw.orcid || null,
    matchScore: computeMatchScore(rawTopics, raw.cited_by_count, target),
  };
}

/** Normalize a raw OpenAlex work record → paper DTO. */
function normalizeWork(raw) {
  const loc = raw.primary_location || {};
  const src = loc.source || {};
  return {
    id: (raw.id || '').replace('https://openalex.org/', ''),
    title: raw.title || 'Untitled',
    year: raw.publication_year || null,
    venue: src.display_name || null,
    citedByCount: raw.cited_by_count || 0,
    abstract: reconstructAbstract(raw.abstract_inverted_index),
  };
}

// ─── Email discovery helpers (free: NCBI E-utilities, OA PDFs, pattern) ───────
const NCBI_EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
const EMAIL_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // emails are stable; cache a day
const GENERIC_LOCALS = /^(info|contact|admin|editor|journal|journals|support|office|webmaster|enquiries|enquiry|press|media|help|noreply|no-reply|corresponding|author|authors|reprints|permissions)$/;
// Optional NCBI API key raises the E-utilities rate limit 3 → 10 req/s.
const NCBI_API_KEY = process.env.NCBI_API_KEY || '';
const NCBI_KEY_PARAM = NCBI_API_KEY ? `&api_key=${encodeURIComponent(NCBI_API_KEY)}` : '';

/** Fetch NCBI E-utilities efetch XML for one or more ids in a SINGLE request. */
async function ncbiFetch(db, ids) {
  const url = `${NCBI_EUTILS}/efetch.fcgi?db=${db}&id=${encodeURIComponent(ids.join(','))}` +
    `&rettype=xml&retmode=xml&tool=reachout&email=${encodeURIComponent(MAILTO)}${NCBI_KEY_PARAM}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'ReachOut/1.0 (mailto:reachout-app@example.com)' },
  });
  if (!res.ok) throw new Error(`NCBI ${db} ${res.status}`);
  return res.text();
}

/** Normalize + dedupe a list of raw email strings; drop junk/example addresses. */
function cleanEmails(list) {
  const seen = new Set();
  const out = [];
  for (let e of list || []) {
    e = String(e).trim().toLowerCase().replace(/^mailto:/, '').replace(/[.,;:)>\]}'"]+$/, '');
    if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(e)) continue;
    if (/@(example|test|email|domain)\.(com|org|net)$/.test(e)) continue;
    if (seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

/** Pull corresponding-author emails from PMC JATS full-text XML (structured field). */
function emailsFromPmcXml(xml) {
  const out = [];
  const correspBlocks = xml.match(/<corresp[\s\S]*?<\/corresp>/gi) || [];
  for (const block of correspBlocks) {
    for (const tag of block.match(/<email[^>]*>([^<]+)<\/email>/gi) || []) {
      out.push(tag.replace(/<[^>]+>/g, ''));
    }
    out.push(...(block.match(EMAIL_RE) || [])); // mailto ext-links in the same block
  }
  if (!out.length) {
    for (const tag of xml.match(/<email[^>]*>([^<]+)<\/email>/gi) || []) {
      out.push(tag.replace(/<[^>]+>/g, ''));
    }
  }
  return cleanEmails(out);
}

/** Pull emails out of PubMed <Affiliation> free text. */
function emailsFromPubmedXml(xml) {
  const out = [];
  for (const aff of xml.match(/<Affiliation>[\s\S]*?<\/Affiliation>/gi) || []) {
    out.push(...(aff.match(EMAIL_RE) || []));
  }
  return cleanEmails(out);
}

/** homepage_url → registrable domain (handles ac.uk / edu.au style compound TLDs). */
function registrableDomain(url) {
  if (!url) return null;
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '');
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  if (/^(ac|edu|gov|co|org|net)\.[a-z]{2}$/.test(lastTwo)) return parts.slice(-3).join('.');
  return lastTwo;
}

/**
 * Rank email candidates against the professor's name + institution domain.
 * A score ≥ 3 means surname OR institution-domain match — enough to trust the
 * address belongs to this professor rather than a co-author.
 */
function scoreEmailCandidates(emails, { first, last, domain }) {
  const f = (first || '').toLowerCase();
  const l = (last || '').toLowerCase();
  const scored = (emails || []).map((email) => {
    const [localRaw, dom] = email.split('@');
    const local = localRaw.toLowerCase();
    let score = 0;
    if (l.length >= 2 && local.includes(l)) score += 3;
    if (f && (local.includes(f) || (f[0] && local.startsWith(f[0])))) score += 1;
    if (domain && (dom === domain || dom.endsWith('.' + domain))) score += 3;
    if (GENERIC_LOCALS.test(local)) score -= 5;
    return { email, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Does the email's local part actually identify THIS professor (vs a co-author
 * at the same institution)? Corresponding-author emails belong to whoever led the
 * paper, so a domain match alone is not enough — require the surname / name pattern.
 */
function personMatch(email, { first, last }) {
  const local = (email.split('@')[0] || '').toLowerCase();
  const f = (first || '').toLowerCase();
  const l = (last || '').toLowerCase();
  if (l.length >= 3 && local.includes(l)) return true;                 // surname appears
  if (f && l && (local.includes(`${f}.${l}`) || local.includes(`${f}${l}`))) return true;
  if (f && l && local === `${f[0]}${l}`) return true;                  // flast
  return false;
}

/** Highest-scoring candidate that is person-specific to this professor, or null. */
function pickPersonEmail(emails, matchCtx) {
  const scored = scoreEmailCandidates(emails, matchCtx).filter((c) => personMatch(c.email, matchCtx));
  return scored.length ? scored[0] : null;
}

/** Split a combined PMC efetch document into per-article { id, chunk }. */
function splitPmcArticles(xml) {
  return xml.split(/(?=<article[ >])/)
    .filter((c) => /^<article[ >]/.test(c))
    .map((chunk) => {
      const m = chunk.match(/<article-id[^>]*pub-id-type="pmc(?:id)?"[^>]*>([^<]+)<\/article-id>/i);
      return { id: m ? normPmcid(m[1]) : null, chunk };
    });
}

/** Split a combined PubMed efetch document into per-article { id, chunk }. */
function splitPubmedArticles(xml) {
  return xml.split(/(?=<PubmedArticle>)/)
    .filter((c) => c.startsWith('<PubmedArticle'))
    .map((chunk) => {
      const m = chunk.match(/<PMID[^>]*>(\d+)<\/PMID>/);
      return { id: m ? m[1] : null, chunk };
    });
}

/**
 * Find the first person-matching email across a batch of NCBI ids in ONE efetch
 * request. Chunks are re-ordered to the requested `ids` order so "first match
 * wins" picks the same article (and source) as a per-id scan would — only faster.
 */
async function findEmailFromNcbiBatch(db, ids, splitFn, parseFn, matchCtx, sourceFn) {
  try {
    const byId = new Map();
    for (const a of splitFn(await ncbiFetch(db, ids))) {
      if (a.id && !byId.has(a.id)) byId.set(a.id, a.chunk);
    }
    for (const id of ids) {
      const chunk = byId.get(id);
      if (!chunk) continue;
      const best = pickPersonEmail(parseFn(chunk), matchCtx);
      if (best) return { email: best.email, source: sourceFn(id) };
    }
  } catch { /* fall through to the next tier */ }
  return null;
}

/** Map PubMed PMIDs → PMCIDs via the NCBI ID Converter API (OpenAlex's pmcid is sparse). */
async function pmidsToPmcids(pmids) {
  if (!pmids.length) return [];
  try {
    const url = `https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?ids=${pmids.join(',')}` +
      `&format=json&tool=reachout&email=${encodeURIComponent(MAILTO)}${NCBI_KEY_PARAM}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ReachOut/1.0 (mailto:reachout-app@example.com)' },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.records || []).map((r) => normPmcid(r.pmcid)).filter(Boolean);
  } catch {
    return [];
  }
}

/** Download a PDF with a timeout + size cap; returns a Buffer or null. */
async function fetchPdfBuffer(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'ReachOut/1.0 (mailto:reachout-app@example.com)' },
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!/pdf/i.test(ct) && !/\.pdf($|\?)/i.test(url)) return null;
    const ab = await res.arrayBuffer();
    if (ab.byteLength > 10 * 1024 * 1024) return null;
    return Buffer.from(ab);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Extract emails from a PDF buffer (best-effort; never throws). */
async function extractEmailsFromPdf(buffer) {
  try {
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    if (typeof parser.destroy === 'function') await parser.destroy();
    return cleanEmails((result.text || '').match(EMAIL_RE) || []);
  } catch {
    return [];
  }
}

const normPmcid = (v) => { const m = String(v || '').match(/PMC(\d+)/i); return m ? m[1] : null; };
const normPmid = (v) => { const m = String(v || '').match(/(\d{4,})/); return m ? m[1] : null; };

/** Build common email-pattern guesses from name + institution domain. */
function guessEmails(first, last, domain) {
  if (!domain || !first || !last) return [];
  return [
    `${first}.${last}@${domain}`,
    `${first[0]}${last}@${domain}`,
    `${last}@${domain}`,
    `${first}${last}@${domain}`,
  ].map((e) => e.toLowerCase());
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/** Health check */
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/**
 * Core discovery logic — reusable by both the HTTP route and the resume endpoint.
 * Returns the same shape as the HTTP response body.
 */
async function discoverByField(field, { page = 1, perPage = 12, preferredFieldId = null } = {}) {
  const topic = await resolveTopicId(field, preferredFieldId);
  if (!topic) return { field, topic: null, total: 0, page, results: [] };

  const target = { topicId: topic.id, fieldId: topic.fieldId, subfieldId: topic.subfieldId };

  const filter = [
    `topics.id:${topic.id}`,
    'last_known_institutions.type:education',
    'works_count:>4',
  ].join(',');

  const select = [
    'id', 'display_name', 'orcid',
    'works_count', 'cited_by_count',
    'last_known_institutions', 'topics',
  ].join(',');

  // Over-fetch on cited_by_count recall, then precision-filter below. We always
  // pull a wide page (25) so the top-5-topic filter has enough candidates even
  // when the caller only wants `perPage` cards.
  const recall = 25;
  const authorsPath = `/authors?filter=${encodeURIComponent(filter)}&sort=cited_by_count:desc&per_page=${recall}&page=${page}&select=${select}`;
  const authorsData = await oaFetch(authorsPath);
  const rawAuthors = authorsData.results || [];
  const total = authorsData.meta?.count || 0;

  // Precision filter: keep an author only if the resolved topic is among their
  // TOP 5 topics. OpenAlex orders topics[] by count desc, so a low index means
  // this topic is central to their work — this is what removes the off-topic
  // "most-cited author with one tangential paper" noise.
  const kept = rawAuthors.filter((a) => {
    const idx = (a.topics || []).findIndex(
      (t) => (t.id || '').replace('https://openalex.org/', '') === topic.id
    );
    return idx >= 0 && idx < 5;
  });

  const results = kept
    .map((a) => normalizeAuthor(a, target))
    .sort((x, y) => y.matchScore - x.matchScore)
    .slice(0, perPage);

  return { field, topic: topic.name, total, page, perPage, results };
}

/**
 * Discover researchers by field.
 * Query params:
 *   field      - free text (e.g. "robotics", "climate science")  default: "machine learning"
 *   page       - page number (1-indexed)                          default: 1
 *   per_page   - results per page (max 25)                        default: 12
 */
app.get('/api/discover', async (req, res) => {
  try {
    const field = (req.query.field || 'machine learning').trim();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const perPage = Math.min(25, Math.max(1, parseInt(req.query.per_page) || 12));
    const data = await discoverByField(field, { page, perPage });
    res.json(data);
  } catch (err) {
    console.error('[/api/discover]', err.message);
    res.status(502).json({ error: 'Failed to reach OpenAlex', detail: err.message });
  }
});

// ─── Resume analysis constants ────────────────────────────────────────────────
const ALLOWED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'application/pdf']);


const RESUME_SYSTEM =
  'You are a resume analyser. Always respond with a single valid JSON object and nothing else — ' +
  'no markdown, no code fences, no prose before or after the JSON.';

const RESUME_PROMPT =
  'Look at this document. First decide: is it a resume or CV? ' +
  'Return a JSON object with exactly these keys:\n' +
  '  "isResume": true if it is clearly a resume or CV, otherwise false\n' +
  '  "transcript": a clean plain-text transcription of the document\'s readable content — ' +
  'name, education, experience, skills, and any sections you can read, preserving order. ' +
  'Use newlines between sections. Empty string if not a resume.\n' +
  '  "interests": array of academic research fields/topics the person is strongest in, ordered strongest-first ' +
  '(empty array if not a resume)\n' +
  '  "summary": one sentence summarising their research background (empty string if not a resume)\n' +
  'Example: {"isResume":true,"transcript":"Jane Doe\\nEducation: BSc Computer Science...","interests":["machine learning","computer vision"],"summary":"PhD candidate in deep learning with a focus on image recognition."}';

/**
 * Analyse a resume image or PDF and suggest matching professors.
 *
 * POST /api/analyze-resume
 * Body: { data: "<base64>", mediaType: "image/png" | "image/jpeg" | "application/pdf" }
 *
 * Response: { interests: string[], summary: string, professors: Professor[] }
 *
 * The file is never persisted — it is sent to Claude, interests extracted, then discarded.
 */
app.post('/api/analyze-resume', async (req, res) => {
  try {
    const { data, mediaType } = req.body || {};

    // ── Validate input ────────────────────────────────────────────────────────
    if (!data || typeof data !== 'string' || data.length < 100) {
      return res.status(400).json({ error: 'Missing or too-small `data` field (base64 string required).' });
    }
    if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
      return res.status(400).json({
        error: `Unsupported mediaType "${mediaType}". Allowed: image/png, image/jpeg, application/pdf.`,
      });
    }

    // ── Build content block for Claude ───────────────────────────────────────
    const isPdf = mediaType === 'application/pdf';
    const fileBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image',    source: { type: 'base64', media_type: mediaType, data } };

    const textBlock = { type: 'text', text: RESUME_PROMPT };

    // PDFs go before the text block; images after is fine too but we keep consistent order.
    const content = isPdf ? [fileBlock, textBlock] : [fileBlock, textBlock];

    // ── Call Claude ──────────────────────────────────────────────────────────
    const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: RESUME_SYSTEM,
      messages: [{ role: 'user', content }],
    });

    let extracted;
    try {
      const rawText = (message.content.find(b => b.type === 'text')?.text || '{}')
        .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      extracted = JSON.parse(rawText);
    } catch {
      return res.status(502).json({ error: 'Claude returned malformed JSON.', raw: message.content });
    }

    if (!extracted.isResume) {
      return res.status(400).json({ error: 'This doesn\'t look like a resume. Please upload a resume or CV.' });
    }

    // Cap interests to top 3 for the matching step.
    const interests = (extracted.interests || []).slice(0, 3).filter(Boolean);
    const summary = extracted.summary || '';
    const transcript = extracted.transcript || '';

    if (!interests.length) {
      return res.json({ interests: [], summary, transcript, professors: [] });
    }

    // ── Match professors via OpenAlex ────────────────────────────────────────
    // Infer the résumé's dominant field from all interests together, then bias each
    // interest's topic pick toward it. This keeps a generic interest ("machine
    // learning", "web development") inside the person's actual domain (Computer
    // Science) instead of drifting to off-domain topics (Materials Science, etc.).
    // An interest with no candidate in the dominant field falls back to its own top
    // topic, so a genuinely off-field interest still surfaces relevant professors.
    const dominantFieldId = await pickDominantField(interests);

    // Run discoverByField for each interest in parallel, then merge and dedupe.
    const perInterest = await Promise.all(
      interests.map(interest =>
        discoverByField(interest, { page: 1, perPage: 12, preferredFieldId: dominantFieldId })
          .catch(() => null)
      )
    );

    // Dedupe by author id. Every author here already passed the per-interest
    // top-5-topic filter, so they're all genuinely relevant. Track how many
    // interests each one hit (cross-interest coverage) and keep their best base
    // score across buckets.
    const seen = new Map(); // authorId → { prof, hitCount }
    perInterest.forEach((bucket) => {
      if (!bucket) return;
      (bucket.results || []).forEach((prof) => {
        const entry = seen.get(prof.id);
        if (entry) {
          entry.hitCount += 1;
          if (prof.matchScore > entry.prof.matchScore) entry.prof = prof;
        } else {
          seen.set(prof.id, { prof, hitCount: 1 });
        }
      });
    });

    // Coverage bonus: an author matching multiple interests is a stronger fit.
    // finalScore = bestBase + (hitCount - 1) * 8, clamped to 99.
    const professors = [...seen.values()]
      .map(({ prof, hitCount }) => ({
        ...prof,
        matchScore: Math.min(99, prof.matchScore + (hitCount - 1) * 8),
      }))
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, 24); // cap; do NOT pad — return fewer if fewer qualify

    res.json({ interests, summary, transcript, professors });
  } catch (err) {
    console.error('[/api/analyze-resume]', err.message);
    if (err.status === 401) {
      return res.status(502).json({ error: 'Invalid or missing ANTHROPIC_API_KEY on the server.' });
    }
    res.status(502).json({ error: 'Resume analysis failed.', detail: err.message });
  }
});

/**
 * Fetch a full researcher profile + recent papers.
 * :authorId is the short OpenAlex id (e.g. A5045033578)
 */
app.get('/api/professor/:authorId', async (req, res) => {
  try {
    const { authorId } = req.params;
    const fullId = authorId.startsWith('A') ? authorId : `A${authorId}`;

    // Fetch author profile and recent works in parallel
    const [authorData, worksData] = await Promise.all([
      oaFetch(`/authors/${fullId}`),
      oaFetch(
        `/works?filter=author.id:${fullId}&sort=publication_date:desc&per_page=5` +
        `&select=id,title,publication_year,primary_location,cited_by_count,abstract_inverted_index`
      ),
    ]);

    const profile = normalizeAuthor(authorData, 0, 1);

    // Augment profile with extra fields available on the single-author endpoint
    profile.summary = buildResearchSummary(authorData, profile);
    // Data-only research block (topics[] + x_concepts[]); profile route only, no
    // extra upstream calls — discover cards don't pay for it.
    profile.research = buildResearchBlock(authorData, profile);

    const recentPapers = (worksData.results || []).map(normalizeWork);
    const latestPublication = recentPapers[0] || null;

    res.json({ profile, recentPapers, latestPublication });
  } catch (err) {
    console.error('[/api/professor]', err.message);
    res.status(502).json({ error: 'Failed to reach OpenAlex', detail: err.message });
  }
});

/**
 * Fetch a professor's papers, pre-bucketed for selection + research directions.
 *
 * GET /api/professor/:authorId/papers?selected_count=5&recent_split_years=4
 * Response: { authorId, papers, selected, directions, links, counts }
 *
 * Data-only (no AI). Merges recent + most-cited works (per_page=25 each),
 * dedupes, flags most-recent/most-cited/preprint, and tallies topic fields into
 * recent vs. earlier research-direction buckets.
 */
app.get('/api/professor/:authorId/papers', async (req, res) => {
  try {
    const { authorId } = req.params;
    const fullId = authorId.startsWith('A') ? authorId : `A${authorId}`;

    const clamp = (v, lo, hi, dflt) => {
      const n = parseInt(v, 10);
      if (!Number.isFinite(n)) return dflt;
      return Math.min(hi, Math.max(lo, n));
    };
    const selectedCount = clamp(req.query.selected_count, 1, 10, 5);
    const recentSplitYears = clamp(req.query.recent_split_years, 1, 10, 4);

    const SELECT =
      'id,ids,title,publication_year,publication_date,type,primary_location,' +
      'best_oa_location,open_access,cited_by_count,topics';

    // Author (for orcid/name/works_count) + two sorted work queries, in parallel.
    const [author, recentData, citedData] = await Promise.all([
      oaFetch(`/authors/${fullId}`),
      oaFetch(`/works?filter=author.id:${fullId}&sort=publication_date:desc&per_page=25&select=${SELECT}`),
      oaFetch(`/works?filter=author.id:${fullId}&sort=cited_by_count:desc&per_page=25&select=${SELECT}`),
    ]);

    // Merge + dedupe by short work id.
    const byId = new Map();
    for (const w of [...(recentData.results || []), ...(citedData.results || [])]) {
      const id = shortId(w.id);
      if (!byId.has(id)) byId.set(id, w);
    }
    const raws = [...byId.values()];

    // Identify the single most-cited and single most-recent works.
    let mostCitedId = null;
    let mostRecentId = null;
    let maxCites = -1;
    let maxDate = '';
    for (const w of raws) {
      const id = shortId(w.id);
      const c = w.cited_by_count || 0;
      if (c > maxCites) { maxCites = c; mostCitedId = id; }
      const d = w.publication_date || '';
      if (d > maxDate) { maxDate = d; mostRecentId = id; }
    }

    const toPaper = (w) => {
      const id = shortId(w.id);
      const loc = w.primary_location || {};
      const src = loc.source || {};
      return {
        id,
        title: w.title || 'Untitled',
        year: w.publication_year || null,
        date: w.publication_date || null,
        venue: src.display_name || null,
        type: w.type || null,
        citedByCount: w.cited_by_count || 0,
        isMostRecent: id === mostRecentId,
        isMostCited: id === mostCitedId,
        isPreprint: w.type === 'preprint',
        oaPdfUrl:
          (w.best_oa_location && w.best_oa_location.pdf_url) ||
          (w.primary_location && w.primary_location.pdf_url) ||
          null,
        isOpenAccess: (w.open_access && w.open_access.is_oa) || false,
      };
    };

    // Full deduped pool, sorted by citations desc (drives the "more" list).
    const papers = raws.map(toPaper).sort((a, b) => b.citedByCount - a.citedByCount);
    // Headline cards: most-recent first, so the profile surfaces their latest
    // work (what outreach emails reference). publication_date is 'YYYY-MM-DD',
    // which sorts lexicographically; fall back to year, then citations.
    const dateKey = (p) => p.date || (p.year ? `${p.year}-00-00` : '');
    const selected = papers
      .slice()
      .sort((a, b) => dateKey(b).localeCompare(dateKey(a)) || b.citedByCount - a.citedByCount)
      .slice(0, selectedCount);

    // Research directions: bucket raw works by year vs. splitYear, tally topic
    // fields (fallback to subfield), emit top 5 {name,count} per bucket.
    const currentYear = new Date().getFullYear();
    const splitYear = currentYear - recentSplitYears;
    const tallyTopics = (works) => {
      const counts = new Map();
      for (const w of works) {
        for (const t of w.topics || []) {
          const name = (t.field && t.field.display_name) || (t.subfield && t.subfield.display_name);
          if (!name) continue;
          counts.set(name, (counts.get(name) || 0) + 1);
        }
      }
      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => ({ name, count }));
    };
    const recentWorks = raws.filter((w) => (w.publication_year || 0) >= splitYear);
    const earlierWorks = raws.filter((w) => (w.publication_year || 0) < splitYear);
    const directions = {
      splitYear,
      recent: tallyTopics(recentWorks),
      earlier: tallyTopics(earlierWorks),
    };

    const name = author.display_name || 'Unknown';
    const links = {
      orcid: author.orcid || null,
      scholar: `https://scholar.google.com/scholar?q=${encodeURIComponent(`"${name}"`)}`,
      openalex: `https://openalex.org/works?filter=author.id:${fullId}`,
    };

    const counts = {
      total: author.works_count || 0,
      fetched: raws.length,
      selected: selected.length,
    };

    res.json({ authorId: fullId, papers, selected, directions, links, counts });
  } catch (err) {
    console.error('[/api/professor/:authorId/papers]', err.message);
    res.status(502).json({ error: 'Failed to reach OpenAlex', detail: err.message });
  }
});

/**
 * Discover a professor's email address from free public sources, on demand.
 *
 * GET /api/professor/:authorId/email
 * Response: { email, confidence: 'verified'|'likely'|'guess'|null,
 *             source, mailtoEnabled, facultySearchUrl, candidates }
 *
 * Tiers (best-first, all free): PMC structured corresponding-author email →
 * PubMed affiliation email → OA PDF parse → institution email-pattern guess.
 */
app.get('/api/professor/:authorId/email', async (req, res) => {
  const { authorId } = req.params;
  const fullId = authorId.startsWith('A') ? authorId : `A${authorId}`;
  const cacheKey = `email:${fullId}`;

  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < EMAIL_CACHE_TTL_MS) return res.json(cached.data);

  const payload = {
    email: null,
    confidence: null,
    source: null,
    mailtoEnabled: false,
    facultySearchUrl: null,
    candidates: [],
  };

  try {
    // Round A — author + works are independent; fetch them together.
    const [author, worksData] = await Promise.all([
      oaFetch(`/authors/${fullId}`),
      oaFetch(
        `/works?filter=author.id:${fullId}&sort=publication_date:desc&per_page=25` +
        `&select=id,ids,open_access,best_oa_location,primary_location`
      ),
    ]);

    const name = author.display_name || 'Unknown';
    const tokens = name.replace(/[^A-Za-z\s'-]/g, ' ').split(/\s+/).filter(Boolean);
    const first = (tokens[0] || '').toLowerCase();
    const last = (tokens[tokens.length - 1] || '').toLowerCase();

    const inst = (author.last_known_institutions || [])[0] || {};
    const institution = inst.display_name || '';
    // Provisional query — overridden below once the institution domain resolves.
    payload.facultySearchUrl =
      `https://www.google.com/search?q=${encodeURIComponent(`"${name}" ${institution} faculty profile`)}`;

    const works = worksData.results || [];
    const pmids = [...new Set(works.map((w) => normPmid(w.ids && w.ids.pmid)).filter(Boolean))].slice(0, 15);

    // Round B — institution domain + PMID→PMCID mapping are independent; together.
    const [domain, pmcConverted] = await Promise.all([
      inst.id
        ? oaFetch(`/institutions/${inst.id.replace('https://openalex.org/', '')}`)
            .then((d) => registrableDomain(d.homepage_url))
            .catch(() => null)
        : Promise.resolve(null),
      pmidsToPmcids(pmids),
    ]);
    const matchCtx = { first, last, domain };

    // Scope the faculty-page search to the institution's own domain when we have it —
    // far more likely to land on the real profile than an open-web search.
    if (domain) {
      payload.facultySearchUrl =
        `https://www.google.com/search?q=${encodeURIComponent(`site:${domain} "${name}"`)}`;
    }

    // Tiers 1 & 2 — PMC (verified) and PubMed (likely) are independent. Run each
    // as ONE batched efetch, in parallel, then prefer the PMC hit. OpenAlex rarely
    // fills ids.pmcid, so PMCIDs come mostly from the converter (Round B).
    const pmcFromOa = works.map((w) => normPmcid(w.ids && w.ids.pmcid)).filter(Boolean);
    const pmcIds = [...new Set([...pmcFromOa, ...pmcConverted])].slice(0, 6);
    const pubmedIds = pmids.slice(0, 6);

    const [pmcHit, pubmedHit] = await Promise.all([
      pmcIds.length
        ? findEmailFromNcbiBatch('pmc', pmcIds, splitPmcArticles, emailsFromPmcXml, matchCtx,
            (id) => `https://www.ncbi.nlm.nih.gov/pmc/articles/PMC${id}/`)
        : null,
      pubmedIds.length
        ? findEmailFromNcbiBatch('pubmed', pubmedIds, splitPubmedArticles, emailsFromPubmedXml, matchCtx,
            (id) => `https://pubmed.ncbi.nlm.nih.gov/${id}/`)
        : null,
    ]);
    if (pmcHit) Object.assign(payload, { email: pmcHit.email, confidence: 'verified', source: pmcHit.source, mailtoEnabled: true });
    else if (pubmedHit) Object.assign(payload, { email: pubmedHit.email, confidence: 'likely', source: pubmedHit.source, mailtoEnabled: true });

    // Tier 3 — OA PDF parse (demoted; for fields not indexed by PubMed). Fetch the
    // first few candidates concurrently, then take the earliest work (in order)
    // that yields a person-matching email — concurrency must not change the winner.
    if (!payload.email) {
      const pdfWorks = works
        .map((w) => ({
          w,
          url: [
            w.best_oa_location && w.best_oa_location.pdf_url,
            w.open_access && w.open_access.oa_url,
            w.primary_location && w.primary_location.pdf_url,
          ].find(Boolean),
        }))
        .filter((x) => x.url)
        .slice(0, 3);
      const pdfResults = await Promise.all(pdfWorks.map(async ({ w, url }) => {
        const buf = await fetchPdfBuffer(url);
        if (!buf) return null;
        const best = pickPersonEmail(await extractEmailsFromPdf(buf), matchCtx);
        return best ? { w, email: best.email } : null;
      }));
      const found = pdfResults.find(Boolean);
      if (found) {
        const w = found.w;
        const landing = (w.primary_location && w.primary_location.landing_page_url) ||
          (w.best_oa_location && w.best_oa_location.landing_page_url) || w.id || null;
        Object.assign(payload, { email: found.email, confidence: 'verified', source: landing, mailtoEnabled: true });
      }
    }

    // Tier 4 — institution email-pattern guess (display-only, never mailto).
    if (!payload.email && domain && first && last) {
      const guesses = guessEmails(first, last, domain);
      Object.assign(payload, {
        email: guesses[0],
        confidence: 'guess',
        source: 'institution-pattern',
        mailtoEnabled: false,
        candidates: guesses,
      });
    }

    cache.set(cacheKey, { data: payload, ts: Date.now() });
    res.json(payload);
  } catch (err) {
    console.error('[/api/professor/:authorId/email]', err.message);
    // Never 500 the client — return whatever we have (the faculty search link
    // is still actionable even when discovery failed).
    res.json(payload);
  }
});

const SHORT_ID_RE = /^https:\/\/openalex\.org\//;
const shortId = (id) => (id || '').replace(SHORT_ID_RE, '');

/**
 * Build a data-only `research` block from the single-author record's topics[]
 * and x_concepts[] (both discarded by normalizeAuthor). PROFILE ROUTE ONLY —
 * no AI, no extra upstream calls.
 *
 * Shape: { areas: [{id,name,subfield,field,domain,count,score}], keywords:
 * [{name,score}], summary: string|null }
 */
function buildResearchBlock(raw, profile) {
  const areas = (raw.topics || [])
    .slice()
    .sort((a, b) => (b.count || 0) - (a.count || 0))
    .slice(0, 8)
    .map((t) => ({
      id: shortId(t.id),
      name: t.display_name || null,
      subfield: (t.subfield && t.subfield.display_name) || null,
      field: (t.field && t.field.display_name) || null,
      domain: (t.domain && t.domain.display_name) || null,
      count: t.count || 0,
      score: t.score || 0,
    }));

  const seenKw = new Set();
  const keywords = [];
  for (const c of (raw.x_concepts || []).slice().sort((a, b) => (b.score || 0) - (a.score || 0))) {
    const name = c.display_name;
    if (!name) continue;
    const key = name.toLowerCase();
    if (seenKw.has(key)) continue;
    seenKw.add(key);
    keywords.push({ name, score: c.score || 0 });
    if (keywords.length >= 12) break;
  }

  return { areas, keywords, summary: buildResearchSummaryFromTopics(raw, profile) };
}

/**
 * Extended research summary built from the topic hierarchy + publication counts.
 * No AI. Returns null when the author has no topics.
 */
function buildResearchSummaryFromTopics(raw, profile) {
  const topics = (raw.topics || []).slice().sort((a, b) => (b.count || 0) - (a.count || 0));
  if (!topics.length) return null;

  const top = topics[0];
  const mainName = top.display_name || 'their field';
  const mainCount = top.count || 0;

  // Distinct higher-level fields/subfields across the top topics.
  const fields = [];
  const seenField = new Set();
  for (const t of topics) {
    const f = (t.field && t.field.display_name) || (t.subfield && t.subfield.display_name);
    if (f && !seenField.has(f)) {
      seenField.add(f);
      fields.push(f);
    }
  }
  const restFields = fields.slice(1, 3);
  const fieldStr = restFields.length
    ? `, drawing on ${restFields.join(' and ')}`
    : '';

  const count = profile.worksCount;
  const cites = profile.citedByCount.toLocaleString();
  const mainStr = mainCount
    ? `${mainName} (${mainCount} works)`
    : mainName;

  return `${profile.name}'s research centers on ${mainStr}${fieldStr}. ` +
    `They have published ${count} works accumulating ${cites} citations.`;
}

/** Build a readable research summary from available metadata. */
function buildResearchSummary(raw, profile) {
  // Use abstract from most recent work if available (populated by worksData above
  // but we don't have it here — summary from topics is the reliable fallback).
  const topics = profile.topics;
  if (!topics.length) return null;

  const main = topics[0];
  const rest = topics.slice(1, 3);
  const restStr = rest.length ? ` alongside work in ${rest.join(' and ')}` : '';
  const count = profile.worksCount;
  const cites = profile.citedByCount.toLocaleString();

  return `${profile.name}'s research centers on ${main}${restStr}. ` +
    `They have published ${count} works accumulating ${cites} citations.`;
}

// ─── Serve frontend ──────────────────────────────────────────────────────────
app.use(express.static(join(__dirname, '..')));

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🔭 ReachOut discovery engine running on http://localhost:${PORT}`);
  console.log(`   Endpoints:`);
  console.log(`   GET  /api/health`);
  console.log(`   GET  /api/discover?field=robotics&page=1&per_page=12`);
  console.log(`   GET  /api/professor/:authorId`);
  console.log(`   GET  /api/professor/:authorId/papers`);
  console.log(`   GET  /api/professor/:authorId/email`);
  console.log(`   POST /api/analyze-resume  (requires ANTHROPIC_API_KEY env var)\n`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn(`   ⚠️  ANTHROPIC_API_KEY is not set — /api/analyze-resume will return 502.\n`);
  }
});
