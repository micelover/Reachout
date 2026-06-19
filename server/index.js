/**
 * ReachOut — Professor Discovery Engine
 * Lightweight Express proxy over the OpenAlex API (free, no key).
 *
 * Port: 8787
 * All OpenAlex calls use the "polite pool" (mailto param) for better rate limits.
 *
 * Endpoints:
 *   GET /api/health
 *   GET /api/discover?field=<text>&page=1&per_page=12
 *   GET /api/professor/:authorId
 */

import express from 'express';

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

// ─── CORS (allow file:// and any localhost origin for dev) ───────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Resolve a free-text field name → best matching OpenAlex topic id + label. */
async function resolveTopicId(field) {
  const data = await oaFetch(`/topics?search=${encodeURIComponent(field)}&per_page=5`);
  const results = data.results || [];
  // Prefer topics with the most works (highest relevance proxy)
  results.sort((a, b) => (b.works_count || 0) - (a.works_count || 0));
  if (!results.length) return null;
  const best = results[0];
  // Strip the OpenAlex URL prefix to get just the short id (e.g. T10883)
  const shortId = best.id.replace('https://openalex.org/', '');
  return { id: shortId, fullId: best.id, name: best.display_name };
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
 * Synthesize a match score (70–99) from the author's rank in the citation-sorted
 * result list and their topic count overlap.
 *
 * NOTE: This is a heuristic display value, not an OpenAlex metric.
 * Rank 0 (most cited on page) → highest score; last rank → lowest.
 */
function computeMatchScore(rank, total, topicCount) {
  const rankFraction = total > 1 ? rank / (total - 1) : 0; // 0=top, 1=bottom
  const base = Math.round(99 - rankFraction * 22); // 77–99
  const topicBonus = Math.min(topicCount, 4) * 0; // reserved for future interest overlap
  return Math.min(99, Math.max(70, base + topicBonus));
}

/** Normalize a raw OpenAlex author record → card/profile DTO. */
function normalizeAuthor(raw, rank = 0, total = 1) {
  const institutions = raw.last_known_institutions || [];
  const primaryInst = institutions[0] || {};
  const topics = (raw.topics || []).slice(0, 4).map((t) => t.display_name);
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
    matchScore: computeMatchScore(rank, total, topics.length),
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

// ─── Routes ──────────────────────────────────────────────────────────────────

/** Health check */
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

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

    // Step 1: resolve field → topic
    const topic = await resolveTopicId(field);
    if (!topic) {
      return res.json({ field, topic: null, total: 0, page, results: [] });
    }

    // Step 2: fetch authors filtered by topic, education type, and minimum work count
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

    const authorsPath = `/authors?filter=${encodeURIComponent(filter)}&sort=cited_by_count:desc&per_page=${perPage}&page=${page}&select=${select}`;
    const authorsData = await oaFetch(authorsPath);
    const rawAuthors = authorsData.results || [];
    const total = authorsData.meta?.count || 0;

    const results = rawAuthors.map((a, i) => normalizeAuthor(a, i, rawAuthors.length));

    res.json({ field, topic: topic.name, total, page, perPage, results });
  } catch (err) {
    console.error('[/api/discover]', err.message);
    res.status(502).json({ error: 'Failed to reach OpenAlex', detail: err.message });
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

    const recentPapers = (worksData.results || []).map(normalizeWork);
    const latestPublication = recentPapers[0] || null;

    res.json({ profile, recentPapers, latestPublication });
  } catch (err) {
    console.error('[/api/professor]', err.message);
    res.status(502).json({ error: 'Failed to reach OpenAlex', detail: err.message });
  }
});

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

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🔭 ReachOut discovery engine running on http://localhost:${PORT}`);
  console.log(`   Endpoints:`);
  console.log(`   GET /api/health`);
  console.log(`   GET /api/discover?field=robotics&page=1&per_page=12`);
  console.log(`   GET /api/professor/:authorId\n`);
});
