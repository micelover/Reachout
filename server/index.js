/**
 * ReachOut — Professor Discovery Engine
 * Lightweight Express proxy over the OpenAlex API (free, no key).
 *
 * Port: 8787
 * All OpenAlex calls use the "polite pool" (mailto param) for better rate limits.
 *
 * Endpoints:
 *   GET  /api/health
 *   GET  /api/locations  (static state/country picker data for the location filter)
 *   GET  /api/discover?field=<text>&unis=<I-ids>&locations=<US-CA,DE,…>&page=1&per_page=12
 *   GET  /api/institutions?q=<prefix>  (OpenAlex prefix autocomplete — research institutions)
 *   GET  /api/institution/:id/logo     (free institution logo URL from OpenAlex/Wikimedia)
 *   GET  /api/schools?q=<prefix>       (Wikidata prefix autocomplete — high schools + universities)
 *   GET  /api/professor/:authorId
 *   GET  /api/professor/:authorId/papers
 *   POST /api/professor/:authorId/email-guide  (deterministic: rank recent papers by student fit)
 *   GET  /api/professor/:authorId/email
 *   POST /api/professor/:authorId/draft-email  (requires ANTHROPIC_API_KEY env var)
 *   POST /api/analyze-resume  (requires ANTHROPIC_API_KEY env var)
 *   POST /api/recommend  (deterministic reply-fit recommendations from a profile)
 *   POST /api/merge-profile  (requires ANTHROPIC_API_KEY env var)
 */

import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { lookup as dnsLookup } from 'dns/promises';
import net from 'net';
import Anthropic from '@anthropic-ai/sdk';
import { PDFParse } from 'pdf-parse';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 8787;
const OPENALEX = 'https://api.openalex.org';
// Real contact email — used in the OpenAlex polite-pool `mailto`, the NCBI
// `tool=reachout&email=`, the Unpaywall `?email=` (which REQUIRES a real address),
// and every upstream `User-Agent`. Overridable via env for redeploys.
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || 'gladwyn504@gmail.com';
// Shared descriptive User-Agent for every upstream (OpenAlex/Wikidata/NCBI/Europe
// PMC/Unpaywall/ROR/ORCID/HTML), carrying the contact email per each service's
// usage policy.
const UA = `ReachOut/1.0 (mailto:${CONTACT_EMAIL})`;
// Captured reference to the real global fetch. The SSRF egress gate only opens real
// sockets when this is still the active fetch; if a test (or any instrumentation)
// has swapped globalThis.fetch for a stub, no internal host can actually be reached,
// so the DNS-resolution step is skipped (a stub doesn't resolve example hosts).
// Production never reassigns globalThis.fetch, so the gate is always fully enforced.
const ORIGINAL_FETCH = globalThis.fetch;
const fetchIsLive = () => globalThis.fetch === ORIGINAL_FETCH;
// Optional OpenAlex API key — moves us off the per-IP anonymous demo budget onto
// the key's $1/day free allowance (and any prepaid/premium budget). Passed as the
// `api_key` query param per OpenAlex docs.
const OPENALEX_API_KEY = process.env.OPENALEX_API_KEY || '';
const OPENALEX_KEY_PARAM = OPENALEX_API_KEY ? `&api_key=${encodeURIComponent(OPENALEX_API_KEY)}` : '';

// ─── Volatile in-memory HTTP cache (10-min TTL) ──────────────────────────────
// Backs oaFetch/wdFetch ONLY — high-churn JSON keyed by full upstream URL. This is
// deliberately NOT the durable cache (see cacheGet/cacheSet below); routing this
// through Firestore would burn writes. Exported so route tests can `cache.clear()`.
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

async function oaFetch(path) {
  const url = `${OPENALEX}${path}${path.includes('?') ? '&' : '?'}mailto=${CONTACT_EMAIL}${OPENALEX_KEY_PARAM}`;
  const cached = cache.get(url);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(4500), // a hung OpenAlex must not stall the request
  });
  if (!res.ok) throw new Error(`OpenAlex ${res.status}: ${path}`);
  const data = await res.json();
  cache.set(url, { data, ts: Date.now() });
  return data;
}

// Cached fetch for arbitrary JSON sources (e.g. Wikidata). Keyed by full URL,
// same TTL as oaFetch. Wikidata's usage policy requires a descriptive User-Agent.
async function wdFetch(url) {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(4500), // don't let a slow Wikidata stall the request
  });
  if (!res.ok) throw new Error(`Wikidata ${res.status}`);
  const data = await res.json();
  cache.set(url, { data, ts: Date.now() });
  return data;
}

// ─── Durable cache abstraction (firebase-admin, env-gated; Map fallback) ──────
// Async key/value store for the SLOW, STABLE email-discovery intermediates and
// final payloads (email:*, unpaywall:*, page:*, europepmc:*, instdomain:*,
// rordomain:*). Distinct from the volatile `cache` Map above:
//   • With FIREBASE_SERVICE_ACCOUNT (base64 service-account JSON) OR
//     GOOGLE_APPLICATION_CREDENTIALS set, durable entries persist in Firestore
//     collection `cache` (doc id = base64url-hash of the key) so a redeploy keeps
//     warm results. firebase-admin is imported LAZILY and fully guarded — any
//     failure (missing module, bad creds, Firestore outage) logs once and falls
//     back to the in-memory Map. `npm test` with no creds never touches the network.
//   • Otherwise everything lives in the same in-memory `cache` Map (durable keys
//     never collide with oaFetch's URL keys), shape { data, expiresAt }.
let _fbInitPromise = null; // memoized in-flight (or settled) init — runs at most once
let _adminAppPromise = null; // memoized firebase-admin app accessor — inits at most once

// Shared lazy firebase-admin app accessor. Resolves to the `admin` module with the
// DEFAULT app initialized exactly once, so BOTH the durable cache (Firestore) and
// Firebase-auth token verification reuse a single app. firebase-admin is imported
// lazily (it's an optional-at-runtime dependency). KEY DETAIL: a service-account
// credential is attached only when one is configured, but the app is ALWAYS
// initialized with an explicit projectId — `admin.auth().verifyIdToken` validates a
// JWT against Google's public certs + projectId and needs NO credential, so token
// verification works even with no creds. (Firestore still requires real creds; that
// gate stays in _initFirebaseCacheOnce.) Never reached under NODE_ENV==='test'.
function getAdminApp() {
  if (!_adminAppPromise) _adminAppPromise = (async () => {
    const admin = (await import('firebase-admin')).default;
    if (!admin.apps.length) {
      const opts = { projectId: process.env.FIREBASE_PROJECT_ID || 'reachout-93272' };
      if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const json = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8'));
        opts.credential = admin.credential.cert(json);
      } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        opts.credential = admin.credential.applicationDefault();
      }
      admin.initializeApp(opts);
    }
    return admin;
  })().catch((err) => {
    // Never cache a rejection — a transient init failure (e.g. a flaky lazy import)
    // would otherwise 401 every later verifyFirebaseToken until restart. Reset the
    // memo so the NEXT call retries init from scratch, and rethrow for this caller.
    _adminAppPromise = null;
    throw err;
  });
  return _adminAppPromise;
}

// Internal: actually attempt firebase-admin init. Resolves to a Firestore handle
// or null. Wrapped once by initFirebaseCache so concurrent first-callers all await
// the SAME promise instead of racing past a synchronous flag and falling back to
// the Map (which would give different callers different backends).
async function _initFirebaseCacheOnce() {
  // Hermetic tests: NEVER touch live Firestore under `npm test` (NODE_ENV=test),
  // even if .env carries creds. The gRPC transport bypasses the fetch mocks, so a
  // live connection would both pollute the prod `cache` collection AND leak stale
  // entries across runs (cacheClear() only wipes the in-memory Map). Force the Map.
  if (process.env.NODE_ENV === 'test') return null;
  const hasCreds = !!(process.env.FIREBASE_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS);
  if (!hasCreds) return null; // no creds → in-memory Map (the default, test-safe path)
  try {
    const admin = await getAdminApp(); // reuse the one shared default app — never double-init
    console.log('[cache] firebase-admin durable cache enabled');
    return admin.firestore();
  } catch (err) {
    console.error('[cache] firebase-admin init failed, using in-memory cache:', err.message);
    return null;
  }
}

function initFirebaseCache() {
  if (!_fbInitPromise) _fbInitPromise = _initFirebaseCacheOnce();
  return _fbInitPromise; // every caller awaits the one shared resolution
}

// Firestore doc ids can't contain '/'; base64url of the key is a safe, reversible id.
const cacheDocId = (key) => Buffer.from(String(key)).toString('base64url');

/** Read a durable cache entry. Returns the stored value or undefined on a miss
 *  (expired entries are misses). Never throws — a backend outage degrades to a miss. */
async function cacheGet(key) {
  const db = await initFirebaseCache();
  if (db) {
    try {
      const snap = await db.collection('cache').doc(cacheDocId(key)).get();
      if (!snap.exists) return undefined;
      const d = snap.data();
      if (!d || typeof d.expiresAt !== 'number' || d.expiresAt <= Date.now()) return undefined;
      return d.value;
    } catch (err) {
      console.error('[cache] get failed:', err.message);
      return undefined;
    }
  }
  const hit = cache.get(key);
  if (!hit || typeof hit.expiresAt !== 'number' || hit.expiresAt <= Date.now()) return undefined;
  return hit.data;
}

/** Write a durable cache entry with a TTL (ms). Never throws. */
async function cacheSet(key, value, ttlMs) {
  const expiresAt = Date.now() + (ttlMs || 0);
  const db = await initFirebaseCache();
  if (db) {
    try {
      await db.collection('cache').doc(cacheDocId(key)).set({ value, expiresAt });
    } catch (err) {
      console.error('[cache] set failed:', err.message);
    }
    return;
  }
  cache.set(key, { data: value, expiresAt });
}

/** Delete a durable cache entry. Never throws — a backend outage is a silent no-op. */
async function cacheDelete(key) {
  const db = await initFirebaseCache();
  if (db) {
    try {
      await db.collection('cache').doc(cacheDocId(key)).delete();
    } catch (err) {
      console.error('[cache] delete failed:', err.message);
    }
    return;
  }
  cache.delete(key);
}

/** Clear the in-memory cache (volatile HTTP entries + in-memory durable entries).
 *  Firestore-backed durable entries are not touched. Used by the test suite. */
function cacheClear() {
  cache.clear();
}

// Durable TTLs (ms).
const DAY_MS = 24 * 60 * 60 * 1000;
const EMAIL_TTL_VERIFIED_MS = 7 * DAY_MS;  // verified/likely email payloads
const EMAIL_TTL_GUESS_MS = 2 * DAY_MS;  // constructed-pattern best-guess + not-found payloads (re-probe sooner)
const INTERMEDIATE_TTL_MS = 30 * DAY_MS;   // unpaywall/page/europepmc/instdomain
const NEG_INTERMEDIATE_TTL_MS = 1 * DAY_MS; // negative author-PMC probe (no PMC paper / no match) — re-probe sooner

// ─── Firebase auth + per-account daily upload limit ──────────────────────────
// verifyFirebaseToken authenticates the caller; the daily-upload helpers enforce a
// 1-résumé-per-day-per-account cap on POST /api/analyze-resume. The cap rides the
// durable cacheGet/cacheSet layer above (Firestore when creds exist, else the
// in-memory Map) — best-effort-durable across redeploys when configured.

/**
 * Verify an `Authorization: Bearer <token>` Firebase ID token. Resolves to { uid }
 * or throws (the caller maps any throw to a 401).
 *
 * Test seam (critical): under NODE_ENV==='test' we NEVER import firebase-admin or
 * touch the network — mirroring the durable-cache test guard so the suite stays
 * hermetic. The token is treated as the literal uid via the form `Bearer test:<uid>`
 * (e.g. `Bearer test:alice` → { uid:'alice' }). In production the token is verified
 * against Google's public certs + projectId via admin.auth().verifyIdToken, which
 * needs NO service-account credential — so auth works even with the cache in Map mode.
 */
async function verifyFirebaseToken(authorizationHeader) {
  const m = /^Bearer\s+(.+)$/i.exec(String(authorizationHeader || '').trim());
  if (!m) throw new Error('Missing or malformed Authorization header');
  const token = m[1].trim();
  if (!token) throw new Error('Empty bearer token');

  if (process.env.NODE_ENV === 'test') {
    const t = /^test:(.+)$/.exec(token);
    if (!t) throw new Error('Invalid test token (expected "test:<uid>")');
    return { uid: t[1] };
  }

  const admin = await getAdminApp();
  const decoded = await admin.auth().verifyIdToken(token);
  return { uid: decoded.uid };
}

/** UTC calendar-day key, e.g. '2026-06-25'. The daily cap rolls over at 00:00 UTC. */
const dayKeyUTC = (date = new Date()) => new Date(date).toISOString().slice(0, 10);

/** Milliseconds from `now` until the next 00:00 UTC — used for the slot TTL and Retry-After. */
function msUntilNextUtcMidnight(now = Date.now()) {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
  return next - now;
}

/** Durable key for one account's daily résumé-upload slot. */
const dailyUploadKey = (uid) => `rl:resume:${uid}:${dayKeyUTC()}`;

/**
 * Reserve today's single résumé-upload slot for `uid`. Returns { ok:true } and marks
 * the slot used, or { ok:false, resetAt } (ISO of next UTC midnight) when already used.
 * Read-then-set: a benign concurrent double-submit could slip a second request through
 * before the first writes — acceptable for a 1/day cap. The slot TTL outlives the UTC
 * day by 60s of slack so it never expires a hair early.
 */
async function reserveDailyUpload(uid) {
  const key = dailyUploadKey(uid);
  const used = await cacheGet(key);
  const resetAt = new Date(Date.now() + msUntilNextUtcMidnight()).toISOString();
  if (used) return { ok: false, resetAt };
  await cacheSet(key, 1, msUntilNextUtcMidnight() + 60000);
  return { ok: true };
}

/** Release today's slot for `uid` (refund after our own / Claude's failure). Never throws. */
async function refundDailyUpload(uid) {
  try {
    await cacheDelete(dailyUploadKey(uid));
  } catch { /* best-effort — a failed refund just costs the user one slot */ }
}

// ─── Body parsing ────────────────────────────────────────────────────────────
// Base64-encoded resume images inflate ~33%, so 15 MB covers ~10 MB source files.
app.use(express.json({ limit: '15mb' }));

// ─── CORS (allow file:// and any localhost origin for dev) ───────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const stripId = (v) => (v ? String(v).replace('https://openalex.org/', '') : null);

/**
 * True when a name is written in the Latin script — keeps Latin + diacritics
 * (José, Müller, Łukasz), rejects names containing any non-Latin letter
 * (Cyrillic, Greek, Han/Kana, Hangul, Arabic, Hebrew, Devanagari, …). Punctuation,
 * spaces, hyphens, apostrophes and digits are ignored; a name must contain at
 * least one Latin letter to pass. Used to drop non-Latin-named authors from
 * discovery results.
 */
function isLatinName(name) {
  const s = String(name || '');
  // Reject if ANY letter is a non-Latin-script letter.
  for (const ch of s) {
    if (/\p{L}/u.test(ch) && !/\p{Script=Latin}/u.test(ch)) return false;
  }
  // Require at least one Latin letter (so empty/punctuation-only names fail).
  return /\p{Script=Latin}/u.test(s);
}

/**
 * True when an author still publishes — used to drop retired/emeritus/deceased
 * researchers from discovery. Keyed on the most recent year with ACTUAL WORKS
 * (works_count > 0) in OpenAlex `counts_by_year`. IMPORTANT: counts_by_year keeps
 * listing recent years for long-dead authors because citations to their old work
 * still accrue (works_count:0, cited_by_count:>0) — so we must require works_count>0,
 * not merely a recent year being present. counts_by_year only spans ~the last
 * decade, so an author whose newest real paper predates that window has no
 * works_count>0 entries → correctly treated as inactive.
 */
function isActiveAuthor(raw, withinYears = 6) {
  const byYear = Array.isArray(raw && raw.counts_by_year) ? raw.counts_by_year : [];
  const pubYears = byYear
    .filter((y) => (y.works_count || 0) > 0)
    .map((y) => y.year)
    .filter(Number.isFinite);
  if (!pubYears.length) return false;
  const lastPub = Math.max(...pubYears);
  const currentYear = new Date().getFullYear();
  return lastPub >= currentYear - withinYears;
}

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
    siblings: Array.isArray(t.siblings) ? t.siblings : [], // related topics in the same subfield
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
    siblings: best.siblings || [],
  };
}

/**
 * Related-topic fan-out for THIN profiles. Resolves `field` to its OpenAlex topic
 * and returns up to `max` of that topic's siblings — related topics in the SAME
 * subfield, already relevance-ordered by OpenAlex — as fully-formed topic objects.
 * Siblings share the subfield, so we reuse the primary topic's field/subfield ids
 * without a second lookup. The caller adds these as extra search buckets purely to
 * widen recall; they never inflate a card's score (see recommendForInterests).
 * Never throws — returns [] on any upstream hiccup.
 */
async function relatedTopics(field, preferredFieldId = null, max = 5) {
  try {
    const primary = await resolveTopicId(field, preferredFieldId);
    if (!primary) return [];
    return (primary.siblings || [])
      .slice(0, max)
      .map((s) => ({
        id: stripId(s.id),
        name: s.display_name,
        fieldId: primary.fieldId,      // siblings share the subfield → same field
        subfieldId: primary.subfieldId,
      }))
      .filter((t) => t.id && t.name);
  } catch {
    return [];
  }
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

// ─── Reply-fit scoring (deterministic, no AI) ────────────────────────────────
// "% Match" is a reply-fit blend — research fit × reply-likelihood — NOT pure
// similarity. Every sub-score is clamped to [0,1] and has an explicit neutral
// default for sparse authors, so the pipeline never emits NaN. Framed in the UI
// as an estimate from public signals, not a guarantee.

const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/**
 * Rough per-field h-index priors keyed by OpenAlex top-level field display_name.
 * h-index is heavily field-skewed (biomed >> CS >> math >> humanities), so the
 * saturation axis normalizes against the author's OWN field. These are LABELED
 * PRIORS — a "field-typical senior" target, not measured cutoffs; v2 calibrates
 * them from logged reply outcomes. ~26 entries covering the OpenAlex field set.
 */
const FIELD_H_BASELINE = {
  'Medicine': 60,
  'Biochemistry, Genetics and Molecular Biology': 55,
  'Immunology and Microbiology': 52,
  'Neuroscience': 52,
  'Pharmacology, Toxicology and Pharmaceutics': 48,
  'Agricultural and Biological Sciences': 45,
  'Physics and Astronomy': 45,
  'Health Professions': 42,
  'Nursing': 38,
  'Earth and Planetary Sciences': 42,
  'Environmental Science': 42,
  'Chemistry': 48,
  'Materials Science': 44,
  'Chemical Engineering': 40,
  'Engineering': 40,
  'Energy': 40,
  'Computer Science': 35,
  'Economics, Econometrics and Finance': 32,
  'Business, Management and Accounting': 30,
  'Social Sciences': 30,
  'Psychology': 38,
  'Decision Sciences': 30,
  'Mathematics': 25,
  'Dentistry': 30,
  'Veterinary': 30,
  'Arts and Humanities': 18,
};
const FIELD_H_DEFAULT = 35; // unknown / missing field → mid prior

/** Field-typical "senior" h-index for a top-level field display_name. */
function baselineHigh(field) {
  if (field && Object.prototype.hasOwnProperty.call(FIELD_H_BASELINE, field)) {
    return FIELD_H_BASELINE[field];
  }
  return FIELD_H_DEFAULT;
}

/**
 * RESP01 — reply likelihood in [0,1] from two robust, low-noise signals.
 *
 *   stats = { active:boolean, recentWorks:number, hIndex:number|null }
 *   dominantField = the AUTHOR's own top-level field display_name (for saturation)
 *
 * Returns { resp01, activityScore, saturationScore } so callers can surface the
 * components in a breakdown without recomputing. No career-stage signal (cut for
 * v1 — disambiguation-noisy and the only source of a confidently-wrong label).
 */
function computeResponsiveness(stats, dominantField) {
  const s = stats || {};

  // activityScore — currently active & productive. Recent-year signal, robust to
  // old-work disambiguation errors. Missing both signals → neutral 0.45.
  let activityScore;
  if (s.active === undefined && (s.recentWorks === undefined || s.recentWorks === null)) {
    activityScore = 0.45;
  } else {
    const recent = Number.isFinite(s.recentWorks) ? s.recentWorks : 0;
    activityScore = clamp01((s.active ? 0.70 : 0.20) + 0.30 * Math.min(recent, 6) / 6);
  }

  // saturationScore — field-normalized inbox saturation (the fame axis). Centered
  // so a field-typical senior is NOT penalized (~1.0); only genuine field-
  // superstars (~2.5× field-typical) approach 0. Missing h-index → neutral 0.7.
  let saturationScore;
  if (!Number.isFinite(s.hIndex)) {
    saturationScore = 0.7;
  } else {
    const fieldNormH = s.hIndex / baselineHigh(dominantField);
    saturationScore = clamp01(1 - (fieldNormH - 1.0) / 1.5);
  }

  const resp01 = clamp01(0.6 * activityScore + 0.4 * saturationScore);
  return { resp01, activityScore, saturationScore };
}

/**
 * computeReplyFitScore — combine topical fit (FIT01) with reply likelihood
 * (RESP01) into the final 30–99 "% Match" plus an explainable breakdown.
 *
 * Args:
 *   bestBase      - max computeMatchScore across matched buckets (50–97).
 *   hitCount      - buckets matched; the `field` bucket counts double.
 *   n             - all.filter(Boolean).length (field + interests).
 *   hasField      - whether a declared field bucket was present.
 *   stats         - { active, recentWorks, hIndex } for THIS author.
 *   dominantField - the author's own top-level field display_name.
 *   goal          - free-text goal; two values lean the blend toward pure fit.
 *   coverage      - (optional) distinct INTEREST buckets matched, for the reason
 *                   string only. The engine tracks field-vs-interest matches
 *                   separately and passes this; omitted → derived from hitCount.
 *
 * Returns { percent, breakdown }. Pure & deterministic.
 */
function computeReplyFitScore({ bestBase, hitCount, n, hasField, stats, dominantField, goal, coverage, prox01 = null }) {
  // FIT01 — topical/field fit, normalized to [0,1]. fitRaw rewards multi-interest
  // coverage (8 = COVERAGE_STEP); maxHit accounts for the field double-count so a
  // full-coverage author lands near 1.0.
  const base = Number.isFinite(bestBase) ? bestBase : 50;
  const hits = Number.isFinite(hitCount) && hitCount > 0 ? hitCount : 1;
  const fitRaw = base + (hits - 1) * 8;
  const maxHit = (Number.isFinite(n) ? n : 1) + (hasField ? 1 : 0);
  const fit01 = clamp01((fitRaw - 50) / (47 + 8 * Math.max(0, maxHit - 1)));

  // RESP01 — reply likelihood from activity + field-normalized saturation.
  const { resp01, activityScore, saturationScore } = computeResponsiveness(stats, dominantField);

  // Goal modifier (collapsed): conversation/shadowing goals care less about how
  // famous/busy the professor is, so lean toward pure fit. Default otherwise.
  const g = (goal || '').toString();
  const leanFit = g.includes('Just a conversation') || g.includes('Shadow / observe');
  const wFit = leanFit ? 0.75 : 0.60;
  const wResp = leanFit ? 0.25 : 0.40;

  // Location proximity — a BOOST-ONLY nudge gated on prox01. When prox01 is null
  // (no student location, or this professor has no resolvable geo) bonus is 0 and
  // the score is byte-identical to the two-term blend. Never negative → never demotes.
  const proxAvail = Number.isFinite(prox01);
  const core = wFit * fit01 + wResp * resp01;
  const bonus = proxAvail ? PROX_CONFIG.wProx * prox01 : 0;
  const percent = Math.min(99, Math.max(30, Math.round(30 + 69 * clamp01(core + bonus))));

  // Deterministic, FACTUAL reasons — strongest-first, NO career-stage claim.
  const reasons = [];
  // Distinct interest buckets the author appeared in. Prefer the explicit count
  // from the engine (field matches tracked separately); else best-effort from
  // hitCount, subtracting the field's double-weight so we never overstate it.
  const interestCoverage = Number.isFinite(coverage)
    ? coverage
    : (hasField ? Math.max(0, hits - 2) : hits);
  if (interestCoverage > 1) {
    reasons.push(`Appears in ${interestCoverage} of your interests`);
  }
  const s = stats || {};
  if (s.active && Number.isFinite(s.recentWorks) && s.recentWorks > 0) {
    reasons.push(`Actively publishing (${s.recentWorks} ${s.recentWorks === 1 ? 'paper' : 'papers'} in last 3 years)`);
  } else if (s.active === false) {
    reasons.push('No recent publications — may be less active');
  }
  if (saturationScore < 0.4) {
    reasons.push('Very high-profile for their field — may have a busy inbox');
  }
  // Location leads the list when it's a strong signal (the card shows a place line).
  if (proxAvail && prox01 >= 0.85) reasons.unshift('Right in your area');
  else if (proxAvail && prox01 >= 0.55) reasons.unshift('Close to your institution');

  return {
    percent,
    breakdown: {
      fit: Math.round(100 * fit01),
      responsiveness: Math.round(100 * resp01),
      components: {
        activity: Math.round(100 * activityScore),
        saturation: Math.round(100 * saturationScore),
      },
      proximity: proxAvail ? Math.round(100 * prox01) : null,
      reasons,
    },
  };
}

/**
 * Normalize a raw OpenAlex author record → card/profile DTO.
 * Pass `target` ({ topicId, fieldId, subfieldId }) to score topical fit to a
 * specific interest; omit it for the plain citation-ordered discover route.
 */
function normalizeAuthor(raw, target = null, selectedIds = null) {
  const institutions = raw.last_known_institutions || [];
  const sid = (i) => (i.id || '').replace('https://openalex.org/', '');
  // Authors often list a secondary affiliation (a national lab, etc.) first.
  // When the caller passed a set of selected institutions, surface the one the
  // user explicitly chose; otherwise, when one affiliation is a curated top-tier
  // school, surface that so the card reflects the prestigious match; else fall back.
  const primaryInst =
    (selectedIds && selectedIds.size
      ? institutions.find((i) => selectedIds.has(sid(i)))
      : null) ||
    institutions.find((i) => PRESTIGE_INSTITUTION_SET.has(sid(i))) ||
    institutions[0] || {};
  const rawTopics = raw.topics || [];
  const topics = rawTopics.slice(0, 4).map((t) => t.display_name);
  const shortId = (raw.id || '').replace('https://openalex.org/', '');

  // Derive reply-fit signals from summary_stats + counts_by_year when present
  // (the discover/name selects request them). Only the three the scorer needs are
  // kept on the card; the raw counts_by_year array is intentionally dropped here.
  const full = buildAuthorStats(raw);
  const stats = { active: full.active, recentWorks: full.recentWorks, hIndex: full.hIndex };
  // The author's OWN dominant field (display name) — saturation normalizes h-index
  // against THIS professor's field baseline, not the searcher's field.
  const dominantField = (rawTopics[0] && rawTopics[0].field && rawTopics[0].field.display_name) || null;

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
    institutionId: sid(primaryInst) || null,
    stats,
    dominantField,
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

// ─── Email discovery helpers (free: Europe PMC, Unpaywall, OA PDFs, pattern) ──
// The hot path is now a DOI-keyed, all-fields fan-out (Europe PMC + Unpaywall +
// arXiv) — see GET /api/professor/:authorId/email. The NCBI-efetch orchestrators
// below are retired from that path but kept (with their exports) so the existing
// unit tests keep passing.
const NCBI_EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const EUROPE_PMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest';
const UNPAYWALL = 'https://api.unpaywall.org/v2';
const ROR_API = 'https://api.ror.org/organizations';
const ORCID_API = 'https://pub.orcid.org/v3.0';
const CROSSREF_API = 'https://api.crossref.org';
const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)+/g;
const GENERIC_LOCALS = /^(info|contact|admin|editor|journal|journals|support|office|webmaster|enquiries|enquiry|press|media|help|noreply|no-reply|corresponding|author|authors|reprints|permissions)$/;
// Optional NCBI API key raises the E-utilities rate limit 3 → 10 req/s.
const NCBI_API_KEY = process.env.NCBI_API_KEY || '';
const NCBI_KEY_PARAM = NCBI_API_KEY ? `&api_key=${encodeURIComponent(NCBI_API_KEY)}` : '';

/** Fetch NCBI E-utilities efetch XML for one or more ids in a SINGLE request. */
async function ncbiFetch(db, ids) {
  const url = `${NCBI_EUTILS}/efetch.fcgi?db=${db}&id=${encodeURIComponent(ids.join(','))}` +
    `&rettype=xml&retmode=xml&tool=reachout&email=${encodeURIComponent(CONTACT_EMAIL)}${NCBI_KEY_PARAM}`;
  await assertPublicHttpUrl(url); // constant host, but gate for consistency
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(4500), // bounded; findEmailFromNcbiBatch catches the abort
  });
  if (!res.ok) throw new Error(`NCBI ${db} ${res.status}`);
  // Defense-in-depth byte cap so an oversized response can't feed extractEmails/
  // EMAIL_RE an unbounded string. 8MB is generous: batched PMC full-text (up to
  // ~10 articles) is legitimately a few MB and never truncated, while abuse is bounded.
  const NCBI_CAP = 8 * 1024 * 1024;
  const t = await res.text();
  return t.length > NCBI_CAP ? t.slice(0, NCBI_CAP) : t;
}

/** Strip diacritics so "José" compares as "jose" (NFD → drop combining marks). */
const fold = (s) => String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '');

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

/**
 * Pull every email out of free text, recovering forms a plain regex misses:
 *   • bracketed de-obfuscation — "name (at) host (dot) edu", "name [at] host [dot] edu"
 *     → name@host.edu  (bare " at "/" dot " are NOT rewritten — they fire on prose)
 *   • author lists — "{a, b, c}@host.edu" (bracketed, any count) and the bare
 *     two-author "a/b@host.edu" shared-mailbox form → one address each
 * Everything funnels through cleanEmails, whose strict final regex is the
 * false-positive bound: a rewrite that yields no email-shaped token is dropped, and
 * a spurious hit still has to pass personMatch before it can ever be chosen.
 */
function extractEmails(text) {
  const raw = String(text || '');
  const out = [];

  // 1) Lists FIRST so members come out in document order, before the plain scan
  //    picks up only the trailing "…b@host" of an "a/b@host" form.
  //    Bracketed lists carry clear intent → expand any count (cap 8):
  //    "{a, b, c}@host" / "(a/b)@host" → one address each.
  const BRACKET_LIST_RE = /[([{]\s*([a-z0-9._%+\-]+(?:\s*[,/]\s*[a-z0-9._%+\-]+)+)\s*[)\]}]@([a-z0-9.\-]+\.[a-z]{2,})/gi;
  let m;
  while ((m = BRACKET_LIST_RE.exec(raw)) !== null) {
    for (const loc of m[1].split(/\s*[,/]\s*/).slice(0, 8)) out.push(`${loc}@${m[2]}`);
  }
  //    Bare (unbracketed) form is only trusted as a two-author shared mailbox —
  //    "alice/bob@host" → alice@host, bob@host. Avoids over-expanding file paths
  //    and prose comma-lists into fabricated addresses.
  //    The (?<!\/) anchor rejects a 3+-token slash chain (a file path like
  //    "a/b/c@x") so only a genuine two-author "a/b@host" expands.
  const PAIR_RE = /(?<!\/)([a-z0-9._%+\-]+)\s*\/\s*([a-z0-9._%+\-]+)@([a-z0-9.\-]+\.[a-z]{2,})/gi;
  let p;
  while ((p = PAIR_RE.exec(raw)) !== null) out.push(`${p[1]}@${p[3]}`, `${p[2]}@${p[3]}`);

  // 2) Plain addresses from the original — never lose a clean hit to a rewrite.
  out.push(...(raw.match(EMAIL_RE) || []));

  // 3) De-obfuscate only BRACKETED forms — "(at)"/"[dot]"/"{at}" carry real anti-scrape
  //    intent. Bare " at "/" dot " are deliberately left alone: they fire on ordinary
  //    prose ("look at stanford.edu") and would fabricate plausible-but-wrong addresses.
  const deob = raw
    .replace(/\s*[([{]\s*at\s*[)\]}]\s*/gi, '@')
    .replace(/\s*[([{]\s*dot\s*[)\]}]\s*/gi, '.');
  if (deob !== raw) out.push(...(deob.match(EMAIL_RE) || []));

  return cleanEmails(out);
}

/** Pull corresponding-author emails from PMC JATS full-text XML (structured field). */
function emailsFromPmcXml(xml) {
  const out = [];
  const correspBlocks = xml.match(/<corresp[\s\S]*?<\/corresp>/gi) || [];
  for (const block of correspBlocks) {
    for (const tag of block.match(/<email[^>]*>([^<]+)<\/email>/gi) || []) {
      out.push(tag.replace(/<[^>]+>/g, ''));
    }
    out.push(...extractEmails(block)); // mailto ext-links + obfuscated forms in the block
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
  const affs = (xml.match(/<Affiliation>[\s\S]*?<\/Affiliation>/gi) || []).join('\n');
  return extractEmails(affs);
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
 * Resolve an institution's registrable email domain, cached per institution so
 * every professor at the same school is a Map hit instead of a fresh OpenAlex
 * round-trip. Negatives (no homepage / lookup failure) are cached too. `instId`
 * is the short OpenAlex id, e.g. 'I97018004'.
 */
async function institutionDomain(instId) {
  if (!instId) return null;
  const key = `instdomain:${instId}`;
  const hit = await cacheGet(key);
  if (hit !== undefined) return hit; // cached value (may be null negative)
  let domain = null;
  try {
    const d = await oaFetch(`/institutions/${instId}`);
    domain = registrableDomain(d.homepage_url);
  } catch {
    domain = null;
  }
  await cacheSet(key, domain, INTERMEDIATE_TTL_MS);
  return domain;
}

/**
 * The professor's primary institution. OpenAlex `last_known_institutions[0]` is
 * frequently a stale or secondary affiliation (a research bureau, a visiting post,
 * or a name-collision error) — which then resolves to the wrong email domain. The
 * author's `affiliations[]` carry each institution with the YEARS they published
 * from it, so the one with the longest sustained, most recent tenure is a far more
 * reliable "home" than last_known[0]. Education-type institutions win ties over
 * companies/bureaus. This lives on the already-fetched author object (no extra call).
 */
function primaryInstitution(author) {
  let best = null;
  for (const a of author.affiliations || []) {
    const inst = a.institution;
    if (!inst || !inst.id) continue;
    const years = a.years || [];
    // Sustained tenure dominates; recency and education-type break ties.
    const score = years.length * 1000 + (years.length ? Math.max(...years) : 0) +
      (inst.type === 'education' ? 0.5 : 0);
    if (!best || score > best.score) best = { inst, score };
  }
  return (best && best.inst) || (author.last_known_institutions || [])[0] || {};
}

/**
 * Rank email candidates against the professor's name + institution domain.
 * A score ≥ 3 means surname OR institution-domain match — enough to trust the
 * address belongs to this professor rather than a co-author.
 */
function scoreEmailCandidates(emails, { first, last, domain }) {
  const f = fold((first || '').toLowerCase());
  const l = fold((last || '').toLowerCase());
  // Hyphenated surnames score on either half (emails usually drop the hyphen).
  const surnames = (l.includes('-') ? l.split('-') : [l]).filter((s) => s.length >= 2);
  const scored = (emails || []).map((email) => {
    const [localRaw, dom] = email.split('@');
    const local = fold(localRaw.toLowerCase());
    let score = 0;
    if (surnames.some((s) => local.includes(s))) score += 3;
    if (f && (local.includes(f) || (f[0] && local.startsWith(f[0])))) score += 1;
    if (domain && (dom === domain || dom.endsWith('.' + domain))) score += 3;
    if (GENERIC_LOCALS.test(local)) score -= 5;
    return { email, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Re-rank candidates by where they sit in the source text: an address next to the
 * professor's surname or a "corresponding author" marker is far likelier to be theirs
 * than one buried among co-authors or in the references. Adds a small proximity bonus
 * on top of scoreEmailCandidates and returns email strings best-first. personMatch
 * stays the hard gate downstream — this only decides WHICH passing candidate wins on
 * a multi-author document.
 */
function rankEmailsByContext(text, emails, matchCtx) {
  const base = scoreEmailCandidates(emails, matchCtx);
  const src = fold(String(text || '').toLowerCase());
  const l = fold((matchCtx.last || '').toLowerCase());

  const anchors = [];
  if (l.length >= 3) {
    for (let i = src.indexOf(l); i !== -1; i = src.indexOf(l, i + 1)) anchors.push(i);
  }
  const MARK_RE = /correspond|electronic address|e-?mail|✉|\*/gi;
  for (let mk; (mk = MARK_RE.exec(src)) !== null; ) anchors.push(mk.index);

  const proximity = (email) => {
    if (!anchors.length) return 0;
    const pos = src.indexOf(fold(email.toLowerCase().split('@')[0]));
    if (pos === -1) return 0;
    const dist = Math.min(...anchors.map((a) => Math.abs(a - pos)));
    return dist <= 60 ? 2 : dist <= 200 ? 1 : 0;
  };

  return base
    .map((c) => ({ email: c.email, score: c.score + proximity(c.email) }))
    .sort((a, b) => b.score - a.score)
    .map((c) => c.email);
}

/**
 * Does the email's local part actually identify THIS professor (vs a co-author
 * at the same institution)? Corresponding-author emails belong to whoever led the
 * paper, so a domain match alone is not enough — require the surname / name pattern.
 */
function personMatch(email, { first, last }) {
  const local = fold((email.split('@')[0] || '').toLowerCase());
  const f = fold((first || '').toLowerCase());
  const l = fold((last || '').toLowerCase());
  const ln = l.replace(/-/g, '');                            // hyphen collapsed
  // The whole surname (≥3 chars) as a substring is a strong signal on its own.
  if (ln.length >= 3 && local.includes(ln)) return true;
  if (f && l) {
    if (local.includes(`${f}.${ln}`) || local.includes(`${f}${ln}`)) return true; // first.last / firstlast
    if (local.includes(`${ln}.${f}`)) return true;                                // last.first (reversed)
    if (local === `${f[0]}${ln}`) return true;                                     // flast
    // A single HALF of a hyphenated surname is ambiguous against a same-surname
    // co-author (a bare "jones@" could be any Jones). Accept it only with the FULL
    // first name present — an initial is too weak to tell "Adam Jones" from "Mary
    // Smith-Jones". (flast on the WHOLE collapsed surname is still handled above.)
    if (l.includes('-') && f.length >= 2 && local.includes(f) &&
        l.split('-').some((h) => h.length >= 3 && local.includes(h))) return true;
  }
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
 * Harvest the linked PMCID from a single PubmedArticle chunk's <ArticleIdList>.
 * A PubMed efetch already carries each article's PMCID, so this lets the PMC tier
 * reuse the PubMed response instead of a separate id-converter round-trip.
 */
function pmcidFromPubmedChunk(chunk) {
  const m = (chunk || '').match(/<ArticleId[^>]*IdType="pmc"[^>]*>\s*(PMC\d+)\s*<\/ArticleId>/i);
  return m ? normPmcid(m[1]) : null;
}

/** Fetch a batch of NCBI ids in ONE efetch and return an ordered id→chunk Map. */
async function fetchNcbiChunks(db, ids, splitFn) {
  const byId = new Map();
  for (const a of splitFn(await ncbiFetch(db, ids))) {
    if (a.id && !byId.has(a.id)) byId.set(a.id, a.chunk);
  }
  return byId;
}

/**
 * First person-matching email across an ordered id→chunk Map. Ids are scanned in
 * request order so "first match wins" picks the same article (and source) a per-id
 * scan would — only faster.
 */
function pickEmailFromChunks(ids, byId, parseFn, matchCtx, sourceFn) {
  for (const id of ids) {
    const chunk = byId.get(id);
    if (!chunk) continue;
    const best = pickPersonEmail(parseFn(chunk), matchCtx);
    if (best) return { email: best.email, source: sourceFn(id) };
  }
  return null;
}

/**
 * Find the first person-matching email across a batch of NCBI ids in ONE efetch
 * request. Returns null on any upstream failure so the caller falls through.
 */
async function findEmailFromNcbiBatch(db, ids, splitFn, parseFn, matchCtx, sourceFn) {
  try {
    const byId = await fetchNcbiChunks(db, ids, splitFn);
    return pickEmailFromChunks(ids, byId, parseFn, matchCtx, sourceFn);
  } catch { /* fall through to the next tier */ }
  return null;
}

/**
 * Download a PDF with a timeout + size cap. With { partial:true } it requests only
 * the first ~1MB via Range — where the author header (and corresponding email) lives —
 * so most papers download a fraction of their bytes. Returns { buffer, truncated }
 * (truncated = server honoured the Range with 206, so deeper pages are missing) or
 * null on failure. truncated:false means we hold the full document.
 */
async function fetchPdfBuffer(url, { partial = false } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3500);
  try {
    const headers = { 'User-Agent': UA };
    if (partial) headers.Range = 'bytes=0-1048575'; // first 1MB
    // SSRF gate per redirect hop (a public PDF URL can 30x to an internal host).
    const res = await guardedFetch(url, { signal: ctrl.signal, headers });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!/pdf/i.test(ct) && !/\.pdf($|\?)/i.test(url)) return null;
    const ab = await res.arrayBuffer();
    if (ab.byteLength > 10 * 1024 * 1024) return null;
    return { buffer: Buffer.from(ab), truncated: res.status === 206 };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Extract emails + the raw text from a PDF buffer (best-effort; never throws). */
async function extractEmailsFromPdfWithText(buffer) {
  try {
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    if (typeof parser.destroy === 'function') await parser.destroy();
    const text = result.text || '';
    return { emails: extractEmails(text), text };
  } catch {
    return { emails: [], text: '' };
  }
}

const normPmcid = (v) => { const m = String(v || '').match(/PMC(\d+)/i); return m ? m[1] : null; };
const normPmid = (v) => { const m = String(v || '').match(/(\d{4,})/); return m ? m[1] : null; };

// ─── SSRF egress gate ─────────────────────────────────────────────────────────
// fetchHtml / fetchPdfBuffer / epmcFetch GET URLs that originate from third parties
// (Unpaywall url_for_landing_page / url_for_pdf, OpenAlex locations, …). Without a
// host check, an attacker-controlled record could point us at the loopback/metadata
// service or an internal host. assertPublicHttpUrl resolves the host via DNS and
// rejects any private/loopback/link-local target; followRedirectsGuarded re-runs the
// gate on every 30x Location (a public URL can redirect to an internal host).
const PRIVATE_BLOCKLIST = (() => {
  const bl = new net.BlockList();
  bl.addSubnet('127.0.0.0', 8);        // loopback
  bl.addSubnet('10.0.0.0', 8);         // RFC1918 private
  bl.addSubnet('172.16.0.0', 12);      // RFC1918 private
  bl.addSubnet('192.168.0.0', 16);     // RFC1918 private
  bl.addSubnet('169.254.0.0', 16);     // link-local (incl. cloud metadata 169.254.169.254)
  bl.addSubnet('0.0.0.0', 8);          // "this" network / unspecified
  bl.addSubnet('::1', 128, 'ipv6');    // loopback
  bl.addSubnet('fc00::', 7, 'ipv6');   // unique local (ULA)
  bl.addSubnet('fe80::', 10, 'ipv6');  // link-local
  bl.addSubnet('::', 128, 'ipv6');     // unspecified
  return bl;
})();

/** True when an IP literal falls in a blocked (private/loopback/link-local) range. */
function isBlockedIp(ip) {
  const v = net.isIP(ip);
  if (!v) return false;
  // IPv4-mapped IPv6 (::ffff:127.0.0.1) — test the embedded v4 too.
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped && PRIVATE_BLOCKLIST.check(mapped[1], 'ipv4')) return true;
  return PRIVATE_BLOCKLIST.check(ip, v === 6 ? 'ipv6' : 'ipv4');
}

/**
 * Reject non-http(s) schemes and any URL whose host resolves to a private/loopback/
 * link-local/multicast address. Throws on rejection (fail-closed, incl. DNS error);
 * each PROBE swallows the throw so the route degrades to the next layer, never 500s.
 */
async function assertPublicHttpUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error('SSRF: malformed URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`SSRF: bad scheme ${u.protocol}`);
  const host = u.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets

  // Literal IP host — check directly, no DNS. Always enforced (cheap, no network).
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error(`SSRF: blocked IP host ${host}`);
    return;
  }
  // Hostname — the DNS-resolution step only matters when a real socket will be
  // opened. If fetch has been stubbed (tests/instrumentation), no internal host can
  // be reached, so skip the lookup. Production keeps the live fetch → always resolves.
  if (!fetchIsLive()) return;
  // Resolve ALL addresses and reject if ANY is private (fail-closed on DNS error).
  // lookup() honours /etc/hosts, so a "localhost" alias is caught too.
  let addrs;
  try {
    addrs = await dnsLookup(host, { all: true });
  } catch {
    throw new Error(`SSRF: DNS resolution failed for ${host}`);
  }
  if (!addrs.length) throw new Error(`SSRF: no address for ${host}`);
  for (const { address } of addrs) {
    if (isBlockedIp(address)) throw new Error(`SSRF: ${host} resolves to blocked ${address}`);
  }
}

/**
 * Fetch that follows redirects MANUALLY (redirect:'manual') so the SSRF gate runs
 * on every hop — a public URL can 30x to an internal host. Caps at maxHops. The
 * caller passes the per-request fetch init (headers/signal); the gate is applied
 * before the first request and before each followed Location. Throws on a blocked
 * host; returns the final non-redirect Response otherwise.
 */
async function guardedFetch(initialUrl, init, { maxHops = 3 } = {}) {
  let url = initialUrl;
  for (let hop = 0; hop <= maxHops; hop++) {
    await assertPublicHttpUrl(url);
    const res = await fetch(url, { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hop === maxHops) throw new Error('SSRF: too many redirects');
      url = new URL(res.headers.get('location'), url).toString(); // resolve relative
      continue;
    }
    return res;
  }
  throw new Error('SSRF: too many redirects');
}

// ─── New upstream fetchers (Europe PMC / Unpaywall / ROR / ORCID / HTML) ───────
// All mirror oaFetch/ncbiFetch: AbortSignal timeout, descriptive User-Agent with
// CONTACT_EMAIL, throw on non-OK. They are intentionally un-cached at the fetch
// layer — the handler caches the DERIVED results under durable DOI/inst keys.
const EMAIL_FETCH_TIMEOUT_MS = 4500;

/** Europe PMC REST. `json:true` parses JSON (search); otherwise returns text
 *  (fullTextXML, which is JATS — the same format emailsFromPmcXml already parses). */
async function epmcFetch(path, { json = true } = {}) {
  const url = `${EUROPE_PMC}${path}`;
  await assertPublicHttpUrl(url); // constant host, but gate for consistency
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: json ? 'application/json' : 'application/xml' },
    signal: AbortSignal.timeout(EMAIL_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`EuropePMC ${res.status}: ${path}`);
  return json ? res.json() : res.text();
}

/** Unpaywall record for a DOI. Unpaywall REQUIRES a real email in `?email=`. */
async function unpaywallFetch(doi) {
  const url = `${UNPAYWALL}/${encodeURIComponent(doi)}?email=${encodeURIComponent(CONTACT_EMAIL)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(EMAIL_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Unpaywall ${res.status}: ${doi}`);
  return res.json();
}

/** ROR organization record — its verified `domains` is the cleanest institutional
 *  email domain (public even when the email isn't). Feeds the Layer 3 guess. */
async function rorFetch(rorId) {
  const id = String(rorId || '').replace(/^https?:\/\/ror\.org\//i, '');
  const url = `${ROR_API}/${encodeURIComponent(id)}`;
  await assertPublicHttpUrl(url); // constant host, but gate for consistency
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(EMAIL_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ROR ${res.status}: ${id}`);
  return res.json();
}

/** ORCID public record section (e.g. 'employments') — confirms the current school. */
async function orcidFetch(orcid, section) {
  const url = `${ORCID_API}/${encodeURIComponent(orcid)}/${section}`;
  await assertPublicHttpUrl(url); // constant host, but gate for consistency
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(EMAIL_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ORCID ${res.status}: ${orcid}`);
  return res.json();
}

/** Crossref work metadata for a DOI. Works even for PAYWALLED papers — that's the
 *  point: Crossref carries author records (occasionally an explicit email) without
 *  needing OA full text. mailto= joins the polite pool. */
async function crossrefFetch(doi) {
  const url = `${CROSSREF_API}/works/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(CONTACT_EMAIL)}`;
  await assertPublicHttpUrl(url); // constant host, but gate for consistency
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(EMAIL_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Crossref ${res.status}: ${doi}`);
  // Defense-in-depth size cap: probeCrossref runs extractEmails(JSON.stringify(...))
  // over this, so an oversized body would feed EMAIL_RE an unbounded string. Read
  // text + bound before parsing (throw is swallowed by probeCrossref's try/catch).
  const t = await res.text();
  if (t.length > 4 * 1024 * 1024) throw new Error('Crossref response too large'); // ~4MB ceiling
  return JSON.parse(t);
}

/**
 * Bounded HTML GET for a paper's landing page: timeout, content-type `text/html`
 * guard, and a ~2MB size cap (read in a streamed loop so we never buffer a huge
 * body). Returns the HTML text, or null on ANY failure (never throws) — landing
 * pages are best-effort.
 */
async function fetchHtml(url, { timeoutMs = 4000, capBytes = 2 * 1024 * 1024 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // SSRF gate per redirect hop (guardedFetch does redirect:'manual' + re-checks).
    const res = await guardedFetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!/text\/html|xhtml/i.test(ct)) return null;
    if (!res.body) {
      const t = await res.text();
      return t.length > capBytes ? t.slice(0, capBytes) : t;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      chunks.push(value);
      if (total >= capBytes) { try { await reader.cancel(); } catch { /* ignore */ } break; }
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract emails from an HTML page: mailto: href targets FIRST (highest intent),
 * then run extractEmails over the de-tagged text (drops scripts/styles so we don't
 * mine analytics/JSON blobs). Returns a cleaned, deduped list.
 */
function emailsFromHtml(html) {
  const out = [];
  const src = String(html || '');
  for (const m of src.matchAll(/href\s*=\s*["']\s*mailto:([^"'?>\s]+)/gi)) out.push(m[1]);
  const text = src
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&(amp|lt|gt|quot|#39|apos);/gi, ' ');
  out.push(...extractEmails(text));
  return cleanEmails(out);
}

/**
 * Race several email-probe thunks concurrently, resolving the instant a `verified`
 * result arrives; otherwise, when budgetMs elapses, return the best result seen so
 * far by confidence rank (verified > likely). Probes that are still running are
 * returned in `pending` so the caller can await them for a background upgrade.
 * Each thunk resolves to { email, confidence, source } or null. Never rejects.
 */
const CONFIDENCE_RANK = { verified: 2, likely: 1 };
function raceForEmail(probeThunks, budgetMs) {
  let best = null;
  const consider = (r) => {
    if (!r || !r.email) return;
    if (!best || (CONFIDENCE_RANK[r.confidence] || 0) > (CONFIDENCE_RANK[best.confidence] || 0)) best = r;
  };
  const pending = probeThunks.map((thunk) => {
    let p;
    try { p = Promise.resolve(thunk()); } catch { p = Promise.resolve(null); }
    return p.then((r) => { consider(r); return r; }, () => null);
  });

  const result = new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer); // tidy: drop the budget timer once we've resolved
      resolve(r);
    };
    for (const p of pending) {
      p.then((r) => { if (r && r.confidence === 'verified') finish(r); });
    }
    // All probes done before the budget → resolve with the best immediately.
    Promise.allSettled(pending).then(() => finish(best));
    timer = setTimeout(() => finish(best), budgetMs);
  });

  return { result, pending };
}

/** OpenAlex doi field/ids.doi → bare lowercase DOI (no scheme), or null. */
function normDoi(raw) {
  if (!raw) return null;
  const m = String(raw).match(/10\.\d{4,9}\/[^\s"'<>]+/);
  return m ? m[0].toLowerCase().replace(/[.,;:)>\]}'"]+$/, '') : null;
}

/** Derive an arXiv id from a work's locations / a DOI (10.48550/arXiv.NNNN.NNNNN). */
function arxivIdFromWork(work, doi) {
  const fromDoi = String(doi || '').match(/10\.48550\/arxiv\.([0-9]{4}\.[0-9]{4,5}(v\d+)?)/i);
  if (fromDoi) return fromDoi[1];
  for (const loc of work.locations || []) {
    const urls = [loc.pdf_url, loc.landing_page_url, loc.source && loc.source.id].filter(Boolean);
    for (const u of urls) {
      const m = String(u).match(/arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5}(v\d+)?)/i);
      if (m) return m[1];
    }
  }
  return null;
}

/**
 * Layer 1 — Europe PMC. Search by DOI; if a PMC full text exists, fetch its JATS
 * XML via NCBI efetch (EuropePMC's own fullTextXML endpoint 404s broadly) and
 * reuse emailsFromPmcXml + pickPersonEmail. A `<corresp>` email is `verified`;
 * an author-affiliation email is `likely`. Cached per DOI.
 * Returns { email, confidence, source } or null. Never throws.
 */
async function probeEuropePmc(doi, matchCtx) {
  const key = `europepmc:${doi}`;
  try {
    const cached = await cacheGet(key);
    if (cached !== undefined) return cached || null;

    let result = null;
    const q = encodeURIComponent(`DOI:"${doi}"`);
    const search = await epmcFetch(`/search?query=${q}&format=json&resultType=core&pageSize=1`);
    const hit = search && search.resultList && search.resultList.result && search.resultList.result[0];
    // Europe PMC's fullTextXML endpoint 404s broadly, so fetch the JATS via NCBI
    // efetch instead — it returns OA full text whenever a PMCID exists (the EPMC
    // isOpenAccess flag proved unreliable, so the gate is just "pmcid present").
    if (hit && hit.pmcid) {
      const xml = await ncbiFetch('pmc', [String(hit.pmcid).replace(/^PMC/i, '')]);
      const correspEmail = pickPersonEmail(emailsFromPmcXml(xml), matchCtx);
      const url = `https://europepmc.org/article/${hit.source}/${hit.id}`;
      if (correspEmail) {
        result = { email: correspEmail.email, confidence: 'verified', source: url };
      } else {
        // Author-affiliation free text → "likely".
        const affEmail = pickPersonEmail(extractEmails(xml), matchCtx);
        if (affEmail) result = { email: affEmail.email, confidence: 'likely', source: url };
      }
    }
    // Found → reuse ~30d; nothing useful → re-probe in ~1d (a paper may get a PMC
    // record or correspondence block added later).
    await cacheSet(key, result, result ? INTERMEDIATE_TTL_MS : NEG_INTERMEDIATE_TTL_MS);
    return result;
  } catch {
    return null;
  }
}

/**
 * Layer 2a — Unpaywall landing page. Resolve the OA landing page, parse its HTML
 * FIRST (emails are usually right there next to the author). A corresponding-marker
 * proximity hit is `verified`; otherwise `likely`. The PDF is intentionally NOT
 * fetched here — that's the off-path background upgrade. Cached per DOI.
 * Returns { email, confidence, source, pdfUrl } | { pdfUrl } | null. Never throws.
 */
async function probeLandingPage(doi, matchCtx) {
  const key = `page:${doi}`;
  try {
    const cached = await cacheGet(key);
    if (cached !== undefined) return cached || null;

    let upw = null;
    try {
      const uKey = `unpaywall:${doi}`;
      upw = await cacheGet(uKey);
      if (upw === undefined) {
        upw = await unpaywallFetch(doi);
        await cacheSet(uKey, upw, INTERMEDIATE_TTL_MS);
      }
    } catch { upw = null; }

    const best = (upw && upw.best_oa_location) || null;
    const landing = best && (best.url_for_landing_page || best.url);
    const pdfUrl = best && (best.url_for_pdf || (/\.pdf($|\?)/i.test(best.url || '') ? best.url : null));

    let result = pdfUrl ? { pdfUrl } : null;
    if (landing) {
      const html = await fetchHtml(landing);
      if (html) {
        const emails = emailsFromHtml(html);
        const ranked = rankEmailsByContext(html, emails, matchCtx);
        const picked = ranked.find((e) => personMatch(e, matchCtx));
        if (picked) {
          // Corresponding-marker proximity → trust as verified, else likely. The
          // email is regex-escaped (a "+" in the local part must not become a
          // quantifier — that would throw a SyntaxError and silently drop the hit).
          const near = /correspond|✉|electronic address/i.test(html) &&
            new RegExp(`correspond[\\s\\S]{0,200}${picked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(html);
          result = { email: picked, confidence: near ? 'verified' : 'likely', source: landing, pdfUrl };
        }
      }
    }
    // Non-null (a found email OR a {pdfUrl} pointer worth reusing) → ~30d; nothing
    // useful → re-probe in ~1d (an OA copy / pdf_url may appear later).
    await cacheSet(key, result, result ? INTERMEDIATE_TTL_MS : NEG_INTERMEDIATE_TTL_MS);
    return result;
  } catch {
    return null;
  }
}

/**
 * Layer 2b — arXiv. Parse the first page of the arXiv PDF (where the author block +
 * email live). Always `likely` (no structured corresponding marker). Off-path
 * latency-wise it's cheap because we Range-request only the first 1MB.
 * Returns { email, confidence, source } or null. Never throws.
 */
async function probeArxiv(arxivId, matchCtx) {
  if (!arxivId) return null;
  try {
    const url = `https://arxiv.org/pdf/${arxivId}`;
    const got = await fetchPdfBuffer(url, { partial: true });
    if (!got) return null;
    const parsed = await extractEmailsFromPdfWithText(got.buffer);
    const ranked = rankEmailsByContext(parsed.text, parsed.emails, matchCtx);
    const picked = ranked.find((e) => personMatch(e, matchCtx));
    return picked ? { email: picked, confidence: 'likely', source: `https://arxiv.org/abs/${arxivId}` } : null;
  } catch {
    return null;
  }
}

/**
 * Parse the OA PDF of a DOI. Runs both in-band (hot path) and in the off-path
 * upgrade; probePdfCached dedupes the parse between them. A corresponding-marker
 * proximity hit (a `/correspond|✉|electronic address/` marker within ~200 chars of
 * the matched email in the PDF text) is `verified`; any other person-matched email
 * is `likely`. Returns { email, confidence, source } or null. Never throws.
 */
async function probePdf(pdfUrl, sourceUrl, matchCtx) {
  if (!pdfUrl) return null;
  try {
    let got = await fetchPdfBuffer(pdfUrl, { partial: true });
    let parsed = got ? await extractEmailsFromPdfWithText(got.buffer) : { emails: [], text: '' };
    if (got && got.truncated && !parsed.emails.length) {
      const full = await fetchPdfBuffer(pdfUrl, { partial: false });
      if (full) parsed = await extractEmailsFromPdfWithText(full.buffer);
    }
    const ranked = rankEmailsByContext(parsed.text, parsed.emails, matchCtx);
    const picked = ranked.find((e) => personMatch(e, matchCtx));
    if (!picked) return null;
    // Mirror probeLandingPage's proximity test: a correspondence marker within ~200
    // chars of the picked email → verified, else likely. The email is regex-escaped
    // (a "+" in the local part must not become a quantifier and throw).
    const near = /correspond|✉|electronic address/i.test(parsed.text) &&
      new RegExp(`correspond[\\s\\S]{0,200}${picked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(parsed.text);
    return { email: picked, confidence: near ? 'verified' : 'likely', source: sourceUrl || pdfUrl };
  } catch {
    return null;
  }
}

/**
 * Cached wrapper around probePdf, keyed per DOI (`pdf:${doi}`) so the hot-path probe
 * and the background upgrade share ONE parse. Found → ~30d; null → re-probe in ~1d.
 * Never throws.
 */
async function probePdfCached(doi, pdfUrl, source, matchCtx) {
  if (!pdfUrl) return null;
  const key = `pdf:${doi}`;
  try {
    const cached = await cacheGet(key);
    if (cached !== undefined) return cached || null;
    const result = await probePdf(pdfUrl, source, matchCtx);
    await cacheSet(key, result, result ? INTERMEDIATE_TTL_MS : NEG_INTERMEDIATE_TTL_MS);
    return result;
  } catch {
    return null;
  }
}

/**
 * Author-level probe — ORCID public record. Added ONCE (not per-DOI) when the author
 * has an ORCID id. ORCID emails are usually private, but a PUBLIC one is authoritative
 * → `verified`. Cached per orcid (found ~30d / null ~1d). Never throws.
 */
async function probeOrcid(orcid, matchCtx) {
  if (!orcid) return null;
  const key = `orcid:${orcid}`;
  try {
    const cached = await cacheGet(key);
    if (cached !== undefined) return cached || null;

    let result = null;
    const record = await orcidFetch(orcid, 'email');
    const emails = cleanEmails((record && record.email || []).map((e) => e && e.email));
    const picked = pickPersonEmail(emails, matchCtx);
    if (picked) result = { email: picked.email, confidence: 'verified', source: `https://orcid.org/${orcid}` };

    await cacheSet(key, result, result ? INTERMEDIATE_TTL_MS : NEG_INTERMEDIATE_TTL_MS);
    return result;
  } catch {
    return null;
  }
}

/**
 * Per-DOI probe — Crossref work metadata. Crossref carries author records even for
 * PAYWALLED papers (no OA full text needed) — that's its value over the OA tiers.
 * Mines any email-shaped token in the author array (explicit `a.email` fields are
 * rare but exact). A person-matched hit is `likely` (no corresponding marker).
 * Cached per DOI (found ~30d / null ~1d). Never throws.
 */
async function probeCrossref(doi, matchCtx) {
  const key = `crossref:${doi}`;
  try {
    const cached = await cacheGet(key);
    if (cached !== undefined) return cached || null;

    let result = null;
    const data = await crossrefFetch(doi);
    const authors = (data && data.message && data.message.author) || [];
    const candidates = extractEmails(JSON.stringify(authors));
    for (const a of authors) if (a && a.email) candidates.push(a.email);
    const picked = pickPersonEmail(cleanEmails(candidates), matchCtx);
    if (picked) result = { email: picked.email, confidence: 'likely', source: `https://doi.org/${doi}` };

    await cacheSet(key, result, result ? INTERMEDIATE_TTL_MS : NEG_INTERMEDIATE_TTL_MS);
    return result;
  } catch {
    return null;
  }
}

/**
 * Layer 1b — author-level PMC. The DOI probes only see the ~25 most-recent works,
 * but the paper that actually carries THIS professor's own email is frequently
 * OLDER than that window. So probe the author's OA PMC papers directly:
 *   1. OpenAlex → the author's open-access PubMed Central works (newest first).
 *      OpenAlex only exposes the pmid here (not the pmcid).
 *   2. ONE batched PubMed efetch over those pmids → each chunk carries its linked
 *      PMCID (pmcidFromPubmedChunk) and the corresponding author's <Affiliation>.
 *   3. ONE batched PMC efetch over those PMCIDs → JATS <corresp> emails (verified).
 *      Falling back to the PubMed affiliation email (likely) when no PMC hit.
 * Batched (all ids in ONE request each) to stay under NCBI's 3 req/s. Cached per
 * author; never throws (returns null on any failure). Returns { email, confidence,
 * source } or null.
 *
 * Id-format note: ncbiFetch('pmc', ids) needs the BARE numeric PMCID and
 * splitPmcArticles keys its map via normPmcid(...) — which also strips the "PMC"
 * prefix to bare digits. pmcidFromPubmedChunk already returns that same bare-numeric
 * form, so the ordered ids we collect double as both the efetch ids AND the map keys
 * pickEmailFromChunks scans. The sourceFn re-adds the "PMC" prefix for the URL.
 */
async function probeAuthorPmc(fullId, matchCtx) {
  const key = `pmcauthor:${fullId}`;
  try {
    const cached = await cacheGet(key);
    if (cached !== undefined) return cached || null;

    let result = null;
    // The author's OA Europe PMC (PubMed Central) works, newest first. OpenAlex
    // surfaces ids.pmid (a PubMed URL) but not the pmcid — we resolve that via NCBI.
    const works = await oaFetch(
      `/works?filter=author.id:${encodeURIComponent(fullId)},` +
      `locations.source.id:https://openalex.org/S4306400806,is_oa:true` +
      `&sort=publication_date:desc&per_page=10&select=ids,doi,publication_date`
    );
    const pmids = [];
    for (const w of (works && works.results) || []) {
      const pmid = normPmid((w.ids && w.ids.pmid) || ''); // ids.pmid is a URL; keep the digits
      if (pmid && !pmids.includes(pmid)) pmids.push(pmid);
    }

    if (pmids.length) {
      // Step 1 — ONE batched PubMed efetch. Per pmid (recency order) harvest the
      // linked PMCID + keep the chunk for the affiliation fallback.
      const pubmedById = await fetchNcbiChunks('pubmed', pmids, splitPubmedArticles);
      const pmcids = [];
      for (const pmid of pmids) {
        const chunk = pubmedById.get(pmid);
        if (!chunk) continue;
        const pmcid = pmcidFromPubmedChunk(chunk); // bare-numeric (normPmcid)
        if (pmcid && !pmcids.includes(pmcid)) pmcids.push(pmcid);
      }

      // Step 2 — ONE batched PMC efetch over the PMCIDs → JATS <corresp> (verified).
      if (pmcids.length) {
        const pmcById = await fetchNcbiChunks('pmc', pmcids, splitPmcArticles);
        const hit = pickEmailFromChunks(
          pmcids, pmcById, emailsFromPmcXml, matchCtx,
          (id) => `https://www.ncbi.nlm.nih.gov/pmc/articles/${/^PMC/i.test(id) ? id : `PMC${id}`}/`
        );
        if (hit) result = { email: hit.email, confidence: 'verified', source: hit.source };
      }

      // Fallback — PubMed <Affiliation> is the corresponding author's free text (likely).
      if (!result) {
        const aff = pickEmailFromChunks(
          pmids, pubmedById, emailsFromPubmedXml, matchCtx,
          (id) => `https://pubmed.ncbi.nlm.nih.gov/${id}/`
        );
        if (aff) result = { email: aff.email, confidence: 'likely', source: aff.source };
      }
    }

    // Found → reuse for ~30d; nothing (no PMC paper / no person match) → re-probe in ~1d.
    await cacheSet(key, result, result ? INTERMEDIATE_TTL_MS : NEG_INTERMEDIATE_TTL_MS);
    return result;
  } catch {
    return null;
  }
}

/**
 * Institution email-pattern best-guesses (Layer 3 fallback). 4 common
 * patterns; the first is shown as `email`, all are returned as `candidates`.
 * Surfaced as a mailable `likely` (source:'institution-pattern'). Returns []
 * if any component is missing.
 */
function guessEmails(first, last, domain) {
  if (!domain || !first || !last) return [];
  return [
    `${first}.${last}@${domain}`,
    `${first[0]}${last}@${domain}`,
    `${last}@${domain}`,
    `${first}${last}@${domain}`,
  ].map((e) => e.toLowerCase());
}

/**
 * Resolve the institution's registrable email domain — for matchCtx scoring, the
 * Layer 3 guess, and to scope the faculty-search link to the institution's site.
 * ROR's verified `domains` FIRST (when a ror id is known), then the institution's
 * OpenAlex homepage/links, then the cached institutionDomain fallback. Never throws.
 */
async function resolveInstitutionDomain(inst, ror) {
  // ROR's verified `domains` is the cleanest source when a ror id is available.
  if (ror) {
    try {
      const rec = await rorFetch(ror);
      const d = (rec && Array.isArray(rec.domains) && rec.domains[0]) || null;
      if (d) return String(d).toLowerCase();
      const link = rec && Array.isArray(rec.links) && rec.links[0];
      const rd = registrableDomain(typeof link === 'string' ? link : (link && link.value));
      if (rd) return rd;
    } catch { /* fall through to OpenAlex homepage */ }
  }
  // OpenAlex institution `links`/homepage as the secondary source.
  const links = (inst && (inst.homepage_url ? [inst.homepage_url] : (inst.links || []))) || [];
  for (const l of links) {
    const d = registrableDomain(l);
    if (d) return d;
  }
  const instId = inst && inst.id ? stripId(inst.id) : '';
  return instId ? await institutionDomain(instId) : null;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/** Health check */
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/**
 * Static location-picker data for the discovery location filter (US states + a
 * curated set of research countries). NO upstream call, no cache, no 400/502 —
 * it has no input and no dependency. Served from the frozen LOCATIONS_PAYLOAD
 * built once at module load. Tokens here are what /api/discover?locations= and
 * POST /api/recommend { locations } accept; resolveLocations turns them into
 * institution ids server-side. Cacheable for a day by the browser/CDN.
 */
app.get('/api/locations', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.json(LOCATIONS_PAYLOAD);
});

/**
 * Core discovery logic — reusable by both the HTTP route and the resume endpoint.
 * Returns the same shape as the HTTP response body.
 */
// Curated set of top-tier institutions (OpenAlex IDs). Discovery is constrained
// to these so recommendations come from prestigious universities rather than a
// random spread. Sourced from OpenAlex /institutions; extend as needed.
const PRESTIGE_INSTITUTIONS = [
  'I63966007',  // MIT
  'I97018004',  // Stanford
  'I136199984', // Harvard
  'I95457486',  // UC Berkeley
  'I122411786', // Caltech
  'I20089843',  // Princeton
  'I40120149',  // Oxford
  'I241749',    // Cambridge
  'I35440088',  // ETH Zurich
  'I74973139',  // Carnegie Mellon
  'I32971472',  // Yale
  'I78577930',  // Columbia
  'I40347166',  // University of Chicago
  'I161318765', // UCLA
  'I79576946',  // University of Pennsylvania
  'I205783295', // Cornell
  'I47508984',  // Imperial College London
  'I185261750', // University of Toronto
  'I27837315',  // University of Michigan
  'I145311948', // Johns Hopkins
  'I201448701', // University of Washington
  'I130701444', // Georgia Tech
  'I36258959',  // UC San Diego
  'I111979921', // Northwestern
  'I157725225', // UIUC
  'I165932596', // National University of Singapore
  'I99065089',  // Tsinghua
  'I5124864',   // EPFL
];
const PRESTIGE_INSTITUTION_SET = new Set(PRESTIGE_INSTITUTIONS);

// ─── Location filter constants ───────────────────────────────────────────────
// OpenAlex has NO author-side region filter, so a location token (US state or
// country) resolves SERVER-SIDE to a set of institution ids (see resolveLocations)
// that are unioned with the user's selected `unis` and fed into the existing
// `last_known_institutions.id:` filter. Union/OR semantics across all locations.
//
// US_STATES: 50 states + DC. State buckets are matched on `region` (the FULL
// English name OpenAlex `geo.region` returns — "California", "District of
// Columbia"), NOT the USPS code, because that's the value present on /institutions.
const US_STATES = [
  { token: 'US-AL', label: 'Alabama', region: 'Alabama' },
  { token: 'US-AK', label: 'Alaska', region: 'Alaska' },
  { token: 'US-AZ', label: 'Arizona', region: 'Arizona' },
  { token: 'US-AR', label: 'Arkansas', region: 'Arkansas' },
  { token: 'US-CA', label: 'California', region: 'California' },
  { token: 'US-CO', label: 'Colorado', region: 'Colorado' },
  { token: 'US-CT', label: 'Connecticut', region: 'Connecticut' },
  { token: 'US-DE', label: 'Delaware', region: 'Delaware' },
  { token: 'US-DC', label: 'Washington, D.C.', region: 'District of Columbia' },
  { token: 'US-FL', label: 'Florida', region: 'Florida' },
  { token: 'US-GA', label: 'Georgia', region: 'Georgia' },
  { token: 'US-HI', label: 'Hawaii', region: 'Hawaii' },
  { token: 'US-ID', label: 'Idaho', region: 'Idaho' },
  { token: 'US-IL', label: 'Illinois', region: 'Illinois' },
  { token: 'US-IN', label: 'Indiana', region: 'Indiana' },
  { token: 'US-IA', label: 'Iowa', region: 'Iowa' },
  { token: 'US-KS', label: 'Kansas', region: 'Kansas' },
  { token: 'US-KY', label: 'Kentucky', region: 'Kentucky' },
  { token: 'US-LA', label: 'Louisiana', region: 'Louisiana' },
  { token: 'US-ME', label: 'Maine', region: 'Maine' },
  { token: 'US-MD', label: 'Maryland', region: 'Maryland' },
  { token: 'US-MA', label: 'Massachusetts', region: 'Massachusetts' },
  { token: 'US-MI', label: 'Michigan', region: 'Michigan' },
  { token: 'US-MN', label: 'Minnesota', region: 'Minnesota' },
  { token: 'US-MS', label: 'Mississippi', region: 'Mississippi' },
  { token: 'US-MO', label: 'Missouri', region: 'Missouri' },
  { token: 'US-MT', label: 'Montana', region: 'Montana' },
  { token: 'US-NE', label: 'Nebraska', region: 'Nebraska' },
  { token: 'US-NV', label: 'Nevada', region: 'Nevada' },
  { token: 'US-NH', label: 'New Hampshire', region: 'New Hampshire' },
  { token: 'US-NJ', label: 'New Jersey', region: 'New Jersey' },
  { token: 'US-NM', label: 'New Mexico', region: 'New Mexico' },
  { token: 'US-NY', label: 'New York', region: 'New York' },
  { token: 'US-NC', label: 'North Carolina', region: 'North Carolina' },
  { token: 'US-ND', label: 'North Dakota', region: 'North Dakota' },
  { token: 'US-OH', label: 'Ohio', region: 'Ohio' },
  { token: 'US-OK', label: 'Oklahoma', region: 'Oklahoma' },
  { token: 'US-OR', label: 'Oregon', region: 'Oregon' },
  { token: 'US-PA', label: 'Pennsylvania', region: 'Pennsylvania' },
  { token: 'US-RI', label: 'Rhode Island', region: 'Rhode Island' },
  { token: 'US-SC', label: 'South Carolina', region: 'South Carolina' },
  { token: 'US-SD', label: 'South Dakota', region: 'South Dakota' },
  { token: 'US-TN', label: 'Tennessee', region: 'Tennessee' },
  { token: 'US-TX', label: 'Texas', region: 'Texas' },
  { token: 'US-UT', label: 'Utah', region: 'Utah' },
  { token: 'US-VT', label: 'Vermont', region: 'Vermont' },
  { token: 'US-VA', label: 'Virginia', region: 'Virginia' },
  { token: 'US-WA', label: 'Washington', region: 'Washington' },
  { token: 'US-WV', label: 'West Virginia', region: 'West Virginia' },
  { token: 'US-WI', label: 'Wisconsin', region: 'Wisconsin' },
  { token: 'US-WY', label: 'Wyoming', region: 'Wyoming' },
];

// RESEARCH_COUNTRIES: a curated set of research-heavy countries. `token` is the
// ISO-2 code OpenAlex `country_code` uses; `hint` is a coarse region label for
// the picker (purely display, never used in resolution).
const RESEARCH_COUNTRIES = [
  { token: 'US', label: 'United States', hint: 'North America' },
  { token: 'CA', label: 'Canada', hint: 'North America' },
  { token: 'GB', label: 'United Kingdom', hint: 'Europe' },
  { token: 'DE', label: 'Germany', hint: 'Europe' },
  { token: 'FR', label: 'France', hint: 'Europe' },
  { token: 'NL', label: 'Netherlands', hint: 'Europe' },
  { token: 'CH', label: 'Switzerland', hint: 'Europe' },
  { token: 'SE', label: 'Sweden', hint: 'Europe' },
  { token: 'IT', label: 'Italy', hint: 'Europe' },
  { token: 'ES', label: 'Spain', hint: 'Europe' },
  { token: 'BE', label: 'Belgium', hint: 'Europe' },
  { token: 'DK', label: 'Denmark', hint: 'Europe' },
  { token: 'NO', label: 'Norway', hint: 'Europe' },
  { token: 'FI', label: 'Finland', hint: 'Europe' },
  { token: 'AT', label: 'Austria', hint: 'Europe' },
  { token: 'IE', label: 'Ireland', hint: 'Europe' },
  { token: 'IL', label: 'Israel', hint: 'Middle East' },
  { token: 'CN', label: 'China', hint: 'Asia' },
  { token: 'JP', label: 'Japan', hint: 'Asia' },
  { token: 'KR', label: 'South Korea', hint: 'Asia' },
  { token: 'SG', label: 'Singapore', hint: 'Asia' },
  { token: 'IN', label: 'India', hint: 'Asia' },
  { token: 'AU', label: 'Australia', hint: 'Oceania' },
  { token: 'NZ', label: 'New Zealand', hint: 'Oceania' },
  { token: 'BR', label: 'Brazil', hint: 'South America' },
  { token: 'ZA', label: 'South Africa', hint: 'Africa' },
];

// O(1) validation set of every valid location token (51 states + 26 countries).
const LOCATION_TOKEN_SET = new Set([
  ...US_STATES.map((s) => s.token),
  ...RESEARCH_COUNTRIES.map((c) => c.token),
]);
// Shape guard: `US-XX` (state) or a bare ISO-2 country code. Pairs with the
// LOCATION_TOKEN_SET membership check at each parse site.
const LOC_RE = /^(US-[A-Z]{2}|[A-Z]{2})$/;
// Fast token → state-region full-name lookup for resolveLocations.
const STATE_REGION_BY_TOKEN = new Map(US_STATES.map((s) => [s.token, s.region]));

// Frozen picker payload, built once at module load (serves GET /api/locations).
const LOCATIONS_PAYLOAD = Object.freeze({
  locations: Object.freeze([
    ...US_STATES.map((s) => Object.freeze({
      token: s.token, label: s.label, type: 'state', country: 'US',
    })),
    ...RESEARCH_COUNTRIES.map((c) => Object.freeze({
      token: c.token, label: c.label, type: 'country', hint: c.hint,
    })),
  ]),
});

async function discoverByField(field, { page = 1, perPage = 12, preferredFieldId = null, unis = [], topic: topicOverride = null } = {}) {
  const hasField = !!(field && field.trim());
  const hasUnis = Array.isArray(unis) && unis.length > 0;

  const select = [
    'id', 'display_name', 'orcid',
    'works_count', 'cited_by_count',
    'last_known_institutions', 'topics',
    // Reply-fit signals (list-level, no extra request): summary_stats has h_index;
    // counts_by_year drives active/recentWorks. Both are derived in normalizeAuthor
    // and the raw arrays are dropped from the card DTO.
    'summary_stats', 'counts_by_year',
  ].join(',');

  // ─── Branch C: selected unis, no field — top-cited authors at those schools ──
  // No topic to resolve, so we lean on true server-side pagination (no recall
  // over-fetch) and skip the top-5-topic precision filter entirely.
  if (!hasField && hasUnis) {
    const filter = [
      `last_known_institutions.id:${unis.join('|')}`,
      'works_count:>4',
    ].join(',');
    const authorsPath = `/authors?filter=${encodeURIComponent(filter)}&sort=cited_by_count:desc&per_page=${perPage}&page=${page}&select=${select}`;
    const authorsData = await oaFetch(authorsPath);
    const rawAuthors = authorsData.results || [];
    const total = authorsData.meta?.count || 0;
    const results = rawAuthors
      .filter((a) => isLatinName(a.display_name) && isActiveAuthor(a))
      .map((a) => normalizeAuthor(a, null, new Set(unis)))
      .slice(0, perPage);
    return { field: '', topic: null, total, page, perPage, results };
  }

  // ─── Branches A & B: field-driven topical discovery ─────────────────────────
  // The route no longer defaults the field, so coerce a default here for the
  // no-unis prestige path to preserve byte-identical legacy behavior.
  const f = hasField ? field.trim() : 'machine learning';
  // A pre-resolved topic (e.g. a related sibling) skips the /topics?search lookup.
  const topic = topicOverride || await resolveTopicId(f, preferredFieldId);
  if (!topic) return { field: f, topic: null, total: 0, page, results: [] };

  const target = { topicId: topic.id, fieldId: topic.fieldId, subfieldId: topic.subfieldId };

  // Branch B (field + selected unis) filters to the user's schools; Branch A
  // (field only) keeps the curated prestige institution list as before.
  const instFilter = hasUnis
    ? `last_known_institutions.id:${unis.join('|')}`
    : `last_known_institutions.id:${PRESTIGE_INSTITUTIONS.join('|')}`;
  const filter = [
    `topics.id:${topic.id}`,
    instFilter,
    'works_count:>4',
  ].join(',');

  // Over-fetch on cited_by_count recall, then precision-filter below. We pull a
  // wide page (~2× the requested count, capped at OpenAlex's 200 max) so the
  // top-5-topic filter has enough candidates to still yield `perPage` cards.
  const recall = Math.min(200, Math.max(25, perPage * 2));
  const authorsPath = `/authors?filter=${encodeURIComponent(filter)}&sort=cited_by_count:desc&per_page=${recall}&page=${page}&select=${select}`;
  const authorsData = await oaFetch(authorsPath);
  const rawAuthors = authorsData.results || [];
  const total = authorsData.meta?.count || 0;

  // Precision filter: keep an author only if the resolved topic is among their
  // TOP 5 topics. OpenAlex orders topics[] by count desc, so a low index means
  // this topic is central to their work — this is what removes the off-topic
  // "most-cited author with one tangential paper" noise.
  const kept = rawAuthors.filter((a) => {
    if (!isLatinName(a.display_name)) return false; // drop non-Latin-named authors
    if (!isActiveAuthor(a)) return false; // drop retired/emeritus/deceased (no recent works)
    const idx = (a.topics || []).findIndex(
      (t) => (t.id || '').replace('https://openalex.org/', '') === topic.id
    );
    return idx >= 0 && idx < 5;
  });

  const selectedIds = hasUnis ? new Set(unis) : null;
  const results = kept
    .map((a) => normalizeAuthor(a, target, selectedIds))
    .sort((x, y) => y.matchScore - x.matchScore)
    .slice(0, perPage);

  return { field: f, topic: topic.name, total, page, perPage, results };
}

/**
 * Resolve already-validated location tokens (US states + countries) to a deduped
 * list of OpenAlex institution ids (`I…`), capped at 150. These are unioned with
 * the user's selected `unis` and fed into `last_known_institutions.id:` so the
 * net effect is "professors at any selected university OR in any selected location".
 *
 * STRICT: lets oaFetch errors propagate (the route try/catch turns them into 502);
 * returns [] ONLY for genuine "no matching institutions". When `tokens` is empty
 * it makes NO upstream call and returns [] — this is what preserves byte-identical
 * backward compat for requests that omit `locations`.
 *
 * Caching: oaFetch's URL-keyed 10-min volatile cache is the only cache here. The
 * state bucket URL is identical for every state, so resolving "US-CA,US-MA,US-NY"
 * is ONE cached OpenAlex call (partitioned by geo.region in JS).
 *
 * @param {string[]} tokens  pre-validated tokens (US-XX or ISO-2)
 * @returns {Promise<string[]>} deduped short institution ids, ≤150
 */
async function resolveLocations(tokens) {
  const list = Array.isArray(tokens) ? tokens : [];
  if (!list.length) return []; // no upstream call — backward-compat hot path

  const countryTokens = list.filter((t) => !t.startsWith('US-'));
  const stateTokens = list.filter((t) => t.startsWith('US-'));

  // Shared US state bucket: fetched once (identical URL for every state). geo.region
  // is null for many entities, so there's no server-side region filter — we pull a
  // wide works_count-desc page and partition in JS.
  let stateBucket = null; // region (full name) → [short ids] in works_count desc order
  if (stateTokens.length) {
    const data = await oaFetch(
      '/institutions?filter=country_code:US,type:education|facility,works_count:>0' +
      '&select=id,display_name,geo,works_count&sort=works_count:desc&per_page=200'
    );
    stateBucket = new Map();
    for (const r of data.results || []) {
      const region = r.geo && r.geo.region;
      if (!region) continue; // skip null/empty region (can't be attributed to a state)
      const id = stripId(r.id);
      if (!id) continue;
      const bucket = stateBucket.get(region);
      if (bucket) bucket.push(id);
      else stateBucket.set(region, [id]);
    }
  }

  // Per-country fetch: country_code is a real OpenAlex filter, so each country is its
  // own (cached) call. Cap each country at its top 40 by works_count.
  const countryIdLists = await Promise.all(
    countryTokens.map(async (code) => {
      const data = await oaFetch(
        `/institutions?filter=country_code:${code},type:education|facility,works_count:>0` +
        '&select=id,works_count&sort=works_count:desc&per_page=40'
      );
      return (data.results || []).map((r) => stripId(r.id)).filter(Boolean).slice(0, 40);
    })
  );
  const countryIds = new Map(countryTokens.map((t, i) => [t, countryIdLists[i]]));

  // Merge in token order so resolution is deterministic; dedupe; cap at 150.
  const out = new Set();
  for (const t of list) {
    let ids;
    if (t.startsWith('US-')) {
      const region = STATE_REGION_BY_TOKEN.get(t);
      ids = (stateBucket && region && stateBucket.get(region) || []).slice(0, 40);
    } else {
      ids = countryIds.get(t) || [];
    }
    for (const id of ids) {
      out.add(id);
      if (out.size >= 150) return [...out];
    }
  }
  return [...out];
}

// ─── Location-proximity ranking (geo helpers) ────────────────────────────────
// A gentle, BOOST-ONLY nudge: professors whose institution is geographically
// closer to the student's own institution rank a little higher. Fully gated —
// when no student location is resolvable the score is byte-identical to before.

/** Great-circle distance in km between {lat,lng} points. null if either invalid. */
function haversineKm(a, b) {
  if (!a || !b) return null;
  const { lat: la1, lng: lo1 } = a;
  const { lat: la2, lng: lo2 } = b;
  if (![la1, lo1, la2, lo2].every(Number.isFinite)) return null;
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(la2 - la1);
  const dLng = rad(lo2 - lo1);
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Tunable proximity policy. wProx is the max blend-units added at proximity 1, so
// the largest possible boost is round(69 * wProx) ≈ +8 match points. L_KM is the
// exponential decay length (proximity halves roughly every L*ln2 ≈ 208 km).
const PROX_CONFIG = { wProx: 0.12, L_KM: 300, floorKm: 5 };

/** Distance (km) → proximity in [0,1]; null when distance is unknown (→ neutral). */
function proximity01(distKm, cfg = PROX_CONFIG) {
  if (!Number.isFinite(distKm)) return null;
  if (distKm <= cfg.floorKm) return 1;
  return Math.exp(-distKm / cfg.L_KM);
}

// Institution coordinates are static — cache them durably for a long time. The
// durable cache distinguishes a MISS (undefined) from a negative hit (stored null),
// so institutions with no geo aren't re-queried on every request.
const INSTGEO_TTL_MS = 90 * DAY_MS;

/**
 * Resolve OpenAlex institution short-ids (`I…`) to {lat,lng,country}.
 * @param {string[]} ids
 * @returns {Promise<Map<string,{lat:number,lng:number,country:string}>>}
 */
async function resolveInstitutionGeos(ids) {
  const want = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => /^I\d+$/.test(id)))];
  const out = new Map();
  const missing = [];
  for (const id of want) {
    const hit = await cacheGet(`instgeo:${id}`); // undefined = miss, null = no-geo, obj = geo
    if (hit !== undefined) { if (hit) out.set(id, hit); }
    else missing.push(id);
  }
  // OpenAlex OR-filter caps at ~50 ids; select only id+geo to keep payloads tiny.
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    let results = [];
    try {
      const data = await oaFetch(
        `/institutions?filter=ids.openalex:${chunk.join('|')}&select=id,geo&per_page=50`
      );
      results = data.results || [];
    } catch {
      continue; // proximity is an enhancement — a geo fetch failure must never throw
    }
    const got = new Set();
    for (const r of results) {
      const id = stripId(r.id);
      if (!id) continue;
      const g = r.geo || {};
      const loc = (Number.isFinite(g.latitude) && Number.isFinite(g.longitude))
        ? { lat: g.latitude, lng: g.longitude, country: g.country_code || '' }
        : null;
      await cacheSet(`instgeo:${id}`, loc, INSTGEO_TTL_MS); // cache negatives too
      if (loc) out.set(id, loc);
      got.add(id);
    }
    for (const id of chunk) if (!got.has(id)) await cacheSet(`instgeo:${id}`, null, INSTGEO_TTL_MS);
  }
  return out;
}

/**
 * Resolve Wikidata entity ids (`Q…`) to {lat,lng} via the P625 coordinate claim.
 * Covers high schools that OpenAlex (a research graph) doesn't index.
 * @param {string[]} qids
 * @returns {Promise<Map<string,{lat:number,lng:number,country:string}>>}
 */
async function resolveWikidataCoords(qids) {
  const want = [...new Set((Array.isArray(qids) ? qids : []).filter((q) => /^Q\d+$/.test(q)))];
  const out = new Map();
  const missing = [];
  for (const q of want) {
    const hit = await cacheGet(`wdgeo:${q}`);
    if (hit !== undefined) { if (hit) out.set(q, hit); }
    else missing.push(q);
  }
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    let entities = {};
    try {
      const url = 'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims' +
        `&ids=${chunk.join('|')}`;
      const data = await wdFetch(url);
      entities = data.entities || {};
    } catch {
      continue;
    }
    for (const q of chunk) {
      const claim = entities[q]?.claims?.P625?.[0]?.mainsnak?.datavalue?.value;
      const loc = (claim && Number.isFinite(claim.latitude) && Number.isFinite(claim.longitude))
        ? { lat: claim.latitude, lng: claim.longitude, country: '' }
        : null;
      await cacheSet(`wdgeo:${q}`, loc, INSTGEO_TTL_MS);
      if (loc) out.set(q, loc);
    }
  }
  return out;
}

/**
 * Best-effort resolve a student's free-text institution NAME to {lat,lng}.
 * OpenAlex autocomplete first (universities/research institutes), then Wikidata
 * (high schools). Durable-cached by normalized name; a stored null means
 * "unresolvable" so we don't re-query. Never throws — proximity just stays off.
 * @param {string} name
 * @returns {Promise<{lat:number,lng:number,country:string}|null>}
 */
async function resolveStudentGeoByName(name) {
  const norm = String(name || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!norm) return null;
  const key = `studgeo:${norm}`;
  const hit = await cacheGet(key);
  if (hit !== undefined) return hit; // null (unresolvable) is a real, cached answer
  let geo = null;
  try {
    const ac = await oaFetch(`/autocomplete/institutions?q=${encodeURIComponent(norm)}`);
    const id = stripId((ac.results || [])[0]?.id);
    if (id) geo = (await resolveInstitutionGeos([id])).get(id) || null;
  } catch { /* fall through to Wikidata */ }
  if (!geo) {
    try {
      const url = 'https://www.wikidata.org/w/api.php?action=query&format=json&list=search' +
        `&srlimit=1&srsearch=${encodeURIComponent(norm)}%20haswbstatement:${SCHOOL_TYPE_FILTER}`;
      const data = await wdFetch(url);
      const qid = (data.query?.search || [])[0]?.title;
      if (/^Q\d+$/.test(qid || '')) geo = (await resolveWikidataCoords([qid])).get(qid) || null;
    } catch { /* leave geo null */ }
  }
  await cacheSet(key, geo, INSTGEO_TTL_MS);
  return geo;
}

/**
 * Decide whether a free-text query is a real research FIELD by checking it
 * against an OpenAlex topic display name. Used to disambiguate field-vs-name.
 * Normalizes both sides (lowercase, punctuation→space, collapse whitespace),
 * then matches on exact equality, prefix containment, or "every query token is
 * one of the topic's name tokens".
 */
function topicMatchesQuery(query, topicName) {
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  const nq = norm(query);
  const nt = norm(topicName);
  if (!nq || !nt) return false;
  if (nq === nt) return true;
  if (nq.startsWith(nt) || nt.startsWith(nq)) return true;
  const topicTokens = new Set(nt.split(' '));
  const queryTokens = nq.split(' ');
  return queryTokens.every((tok) => topicTokens.has(tok));
}

/**
 * Discover researchers by NAME — a global author search (ignores unis).
 * Sibling of discoverByField; same author `select` list, no topic/precision
 * filter. Reuses oaFetch caching.
 */
async function discoverByName(name, { page = 1, perPage = 12 } = {}) {
  const select = [
    'id', 'display_name', 'orcid',
    'works_count', 'cited_by_count',
    'last_known_institutions', 'topics',
    'summary_stats', 'counts_by_year',
  ].join(',');
  const authorsPath = `/authors?filter=display_name.search:${encodeURIComponent(name)}&sort=cited_by_count:desc&per_page=${perPage}&page=${page}&select=${select}`;
  const data = await oaFetch(authorsPath);
  const rawAuthors = (data.results || []).filter(
    (a) => isLatinName(a.display_name) && isActiveAuthor(a) // drop non-Latin-named + retired/deceased
  );
  const results = rawAuthors.map((a) => normalizeAuthor(a, null, null)).slice(0, perPage);
  return { field: name, topic: null, mode: 'name', total: data.meta?.count || 0, page, perPage, results };
}

/**
 * Dispatcher: auto-detect whether a query is a research FIELD or a PROFESSOR
 * NAME and route accordingly. Field wins ties (honors unis); name search is
 * global. Always tags the result with a `mode` flag.
 */
async function discover(query, { page = 1, perPage = 12, unis = [] } = {}) {
  const q = (query || '').trim();
  // Empty query → existing default / unis-only field behavior.
  if (!q) {
    const r = await discoverByField('', { page, perPage, unis });
    return { ...r, mode: 'field' };
  }
  // Does the query look like a real field? (topic fetch is cached by oaFetch, so
  // resolveTopicId inside discoverByField re-uses it for free.)
  const candidates = await fetchTopicCandidates(q);
  if (candidates.some((c) => topicMatchesQuery(q, c.name))) {
    const r = await discoverByField(q, { page, perPage, unis });
    return { ...r, mode: 'field' };
  }
  // Otherwise try it as an author name (global search, unis ignored).
  const named = await discoverByName(q, { page, perPage });
  if (named.results.length) return named;
  // Name search came up empty → fall back to field so the user still sees results.
  const r = await discoverByField(q, { page, perPage, unis });
  return { ...r, mode: 'field' };
}

/**
 * Shared reply-fit recommendation engine — backs BOTH /api/analyze-resume and
 * POST /api/recommend so resume and saved-profile recommendations rank identically.
 *
 * Pipeline (all deterministic, no AI):
 *   1. all = [field, ...interests] (truthy). Empty → [].
 *   2. pickDominantField(all) biases each bucket's topic pick toward the declared
 *      domain (so "machine learning" stays in CS, not Materials Science).
 *   3. Fan out discoverByField per bucket in parallel (failures → null).
 *   4. Dedupe by author id; the `field` bucket counts DOUBLE toward hitCount;
 *      bestBase = max per-bucket computeMatchScore (the topical base, 50–97).
 *   5. computeReplyFitScore per survivor → matchScore (30–99) + breakdown.
 *      Saturation uses the AUTHOR's own dominant field, not the searcher's.
 *   6. Sort by matchScore desc, slice(limit). No padding.
 *
 * @param {string[]} interests
 * @param {{ field?:string, goal?:string, unis?:string[], limit?:number, perPage?:number }} opts
 * @returns {Promise<Professor[]>} cards with matchScore + breakdown (no internal stats)
 */
async function recommendForInterests(interests, { field = '', goal = '', unis = [], limit = 24, perPage, studentGeo = null } = {}) {
  // Per-bucket fetch scales with the requested result cap (when not pinned by the
  // caller): a bigger `limit` pulls a wider page through the SAME precision filter,
  // so we surface more cards to paginate without lowering match quality. The cap is
  // 100 (OpenAlex per-page max is 200) so a limit:150 request can net ~5 pages of
  // survivors after cross-bucket dedupe instead of starving at ~3.
  const effPerPage = perPage ?? Math.min(100, Math.max(12, limit));
  const interestList = (Array.isArray(interests) ? interests : []).map((s) => String(s).trim()).filter(Boolean);
  const fieldStr = (field || '').toString().trim();
  const hasField = !!fieldStr;
  // Buckets the user actually declared: the field (if any) plus each interest.
  const declared = [fieldStr, ...interestList].filter(Boolean);
  if (!declared.length) return [];

  // Score normalization rides on DECLARED intent only. The related-topic buckets
  // added below for thin profiles are recall-only, so `n` (and every card's score)
  // is identical whether or not the fan-out ran.
  const n = declared.length;
  const cleanUnis = Array.isArray(unis) ? unis : [];

  // Bias every bucket's topic resolution toward the searcher's dominant field.
  const dominantFieldId = await pickDominantField(declared);

  // THIN-PROFILE FAN-OUT: with 0–1 interests, a single narrow field (e.g.
  // "healthcare administration") yields too few candidates to fill even one page.
  // Broaden recall with the primary topic's OpenAlex siblings (related topics in
  // the same subfield). RECALL-ONLY — see the dedupe weighting below.
  const related = interestList.length < 2
    ? await relatedTopics(declared[0], dominantFieldId, 5)
    : [];

  // Declared buckets first (so idx 0 stays the field), then the related ones.
  const searchBuckets = [
    ...declared.map((label) => ({ label, topic: null, related: false })),
    ...related.map((t) => ({ label: t.name, topic: t, related: true })),
  ];

  // Fan out one discoverByField per bucket, in parallel; a failed bucket is skipped.
  const buckets = await Promise.all(
    searchBuckets.map((b) =>
      discoverByField(b.label, { page: 1, perPage: effPerPage, preferredFieldId: dominantFieldId, unis: cleanUnis, topic: b.topic })
        .catch(() => null)
    )
  );

  // A total upstream outage (every bucket errored) is a real failure, not an
  // honest "no matches" — surface it as 502 so the UI can say "try again" rather
  // than falsely showing an empty profile match. Partial failures still degrade
  // gracefully in the dedupe below (null buckets are skipped).
  if (buckets.length && buckets.every((b) => b === null)) {
    const err = new Error('Failed to reach OpenAlex');
    err.status = 502;
    throw err;
  }

  // Dedupe by author id. The FIELD bucket counts DOUBLE toward hitCount (declared
  // primary domain, drives FIT01); INTEREST buckets count single and bump
  // interestHits (the honest "appears in N of your interests" reason). RELATED
  // buckets are recall-only: they surface candidates but never touch hitCount /
  // interestHits, so a professor found only via a sibling topic ranks purely on its
  // own topical base + reply-fit, and declared-intent scores stay unchanged.
  const seen = new Map(); // authorId → { prof, hitCount, interestHits, bestBase }
  buckets.forEach((bucket, idx) => {
    if (!bucket) return;
    const b = searchBuckets[idx];
    const isFieldBucket = hasField && idx === 0; // declared[0] is the field when present
    const weight = isFieldBucket ? 2 : 1;
    (bucket.results || []).forEach((prof) => {
      const entry = seen.get(prof.id);
      if (entry) {
        if (!b.related) {
          entry.hitCount += weight;
          if (!isFieldBucket) entry.interestHits += 1;
        }
        if (prof.matchScore > entry.bestBase) {
          entry.bestBase = prof.matchScore;
          entry.prof = prof; // keep the card from the strongest bucket
        }
      } else {
        seen.set(prof.id, {
          prof,
          hitCount: b.related ? 0 : weight,
          interestHits: (!b.related && !isFieldBucket) ? 1 : 0,
          bestBase: prof.matchScore,
        });
      }
    });
  });

  // Location proximity (gated): only when the student's coordinates are known do we
  // resolve the candidate institutions' geos (durably cached) and boost nearby
  // professors. studentGeo null ⇒ this whole block is skipped, no added calls,
  // scores identical to before.
  let geoByInst = new Map();
  if (studentGeo) {
    const instIds = [...new Set([...seen.values()].map(({ prof }) => prof.institutionId).filter(Boolean))];
    if (instIds.length) geoByInst = await resolveInstitutionGeos(instIds);
  }

  // Score each survivor with the reply-fit blend, then strip the internal scoring
  // inputs (stats/dominantField) from the public card.
  const professors = [...seen.values()]
    .map(({ prof, hitCount, interestHits, bestBase }) => {
      const profGeo = studentGeo ? geoByInst.get(prof.institutionId) || null : null;
      const prox01 = studentGeo ? proximity01(haversineKm(studentGeo, profGeo)) : null;
      const { percent, breakdown } = computeReplyFitScore({
        bestBase,
        hitCount,
        n,
        hasField,
        stats: prof.stats,
        dominantField: prof.dominantField,
        goal,
        coverage: interestHits,
        prox01,
      });
      const { stats, dominantField, ...card } = prof; // drop internals from the DTO
      return { ...card, matchScore: percent, breakdown };
    })
    // Primary by score; exact ties break toward the geographically nearer professor.
    .sort((a, b) => (b.matchScore - a.matchScore) ||
      ((b.breakdown.proximity ?? -1) - (a.breakdown.proximity ?? -1)))
    .slice(0, limit); // cap; do NOT pad — return fewer if fewer qualify

  return professors;
}

/**
 * Discover researchers by field OR by professor name (auto-detected).
 * Returns a `mode: 'field' | 'name'` flag alongside the usual shape.
 * Query params:
 *   field      - free text: a research field ("robotics") or a name ("Geoffrey Hinton")
 *   unis       - comma-separated OpenAlex institution ids (field mode only)
 *   page       - page number (1-indexed)                          default: 1
 *   per_page   - results per page (max 50)                        default: 12
 */
app.get('/api/discover', async (req, res) => {
  try {
    const field = (req.query.field || '').trim();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(req.query.per_page) || 12));
    const unis = (req.query.unis || '').trim()
      ? (req.query.unis).split(',').map(s => s.trim()).filter(s => /^I\d+$/.test(s)).slice(0, 25)
      : [];
    // Location filter (US states + countries): each token resolves SERVER-SIDE to
    // institution ids, unioned with `unis`. Bad/unknown tokens are silently dropped
    // (like bad unis); all-invalid behaves as `locations` absent.
    const locations = (req.query.locations || '').trim()
      ? String(req.query.locations).split(',').map(s => s.trim().toUpperCase())
          .filter(s => LOC_RE.test(s) && LOCATION_TOKEN_SET.has(s)).slice(0, 25)
      : [];
    const locInstIds = await resolveLocations(locations);   // [] when locations empty (no upstream call)
    const mergedUnis = [...new Set([...unis, ...locInstIds])].slice(0, 150);
    const data = await discover(field, { page, perPage, unis: mergedUnis });
    // The unscored discover route shouldn't leak the internal reply-fit inputs
    // (stats/dominantField) that normalizeAuthor attaches for the recommend engine.
    if (Array.isArray(data.results)) {
      data.results = data.results.map(({ stats, dominantField, ...card }) => card);
    }
    res.json(data);
  } catch (err) {
    console.error('[/api/discover]', err.message);
    res.status(502).json({ error: 'Failed to reach OpenAlex', detail: err.message });
  }
});

/**
 * Autocomplete academic institutions (for the searchable multi-select uni filter).
 * Uses OpenAlex's /autocomplete endpoint, which does PREFIX matching (typeahead),
 * unlike /institutions?search= which only matches whole tokens. Autocomplete
 * ignores per_page (returns ~10) and exposes a `hint` (location) field.
 * Query params:
 *   q - search text / prefix, min 2 chars (required)
 */
app.get('/api/institutions', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.status(400).json({ error: 'Query must be at least 2 characters' });
    const path = `/autocomplete/institutions?q=${encodeURIComponent(q)}&filter=type:education|facility`;
    const data = await oaFetch(path);
    // Autocomplete returns name-match order, which buries real universities under
    // tiny same-name entities (e.g. a yeast company above UC Berkeley). Use the
    // institution's research output ONLY as a hidden sort key + dead-end filter:
    // drop zero-output entities (no researchers to email), then sort by works_count
    // desc so recognizable, large institutions rank first. These numbers are never
    // exposed in the DTO — the mapping below intentionally omits them.
    const results = (data.results || [])
      .filter((r) => (r.works_count || 0) > 0)
      .sort((a, b) => (b.works_count || 0) - (a.works_count || 0))
      .map((r) => ({
        id: stripId(r.id),
        name: r.display_name || 'Unknown',
        country: '',
        type: '',
        hint: r.hint || '',
      }));
    res.json({ query: q, results });
  } catch (err) {
    console.error('[/api/institutions]', err.message);
    res.status(502).json({ error: 'Failed to reach OpenAlex', detail: err.message });
  }
});

/**
 * Free institution logo lookup — replaces the initials avatar on professor cards
 * with the institution's Wikimedia logo. FREE: just the OpenAlex institutions
 * endpoint (polite pool, optional key), no image service involved.
 *
 * GET /api/institution/:id/logo
 *   :id - OpenAlex institution id (the `institutionId` normalizeAuthor returns), e.g. I136199984
 * Response: { logo: string|null, homepage: string|null }
 *   logo     = image_thumbnail_url (a Wikimedia URL) or null
 *   homepage = homepage_url or null
 *
 * Cached via oaFetch (10-min, keyed by the upstream URL). Because the select-only
 * upstream response is tiny and identical for every card hitting the same
 * institution, this is effectively a per-id cache — null logos included, so
 * logo-less institutions aren't refetched on every card.
 */
app.get('/api/institution/:id/logo', async (req, res) => {
  try {
    const { id } = req.params;
    // Validate/sanitize BEFORE interpolating into the upstream path (SSRF / path
    // injection guard): OpenAlex institution ids are strictly `I` + digits.
    if (!/^I\d+$/.test(id)) {
      return res.status(400).json({ error: 'Invalid institution id (expected OpenAlex id like I136199984)' });
    }
    const data = await oaFetch(
      `/institutions/${id}?select=display_name,image_thumbnail_url,homepage_url`
    );
    res.json({
      logo: data.image_thumbnail_url || null,
      homepage: data.homepage_url || null,
    });
  } catch (err) {
    console.error('[/api/institution/:id/logo]', err.message);
    res.status(502).json({ error: 'Failed to reach OpenAlex', detail: err.message });
  }
});

// Prefix autocomplete for schools (high schools + colleges + universities),
// used by the profile Basics card. Hybrid of two free sources, merged + deduped:
//   - OpenAlex /autocomplete (real prefix typeahead — works from a single letter,
//     covers universities/colleges/research orgs), filtered to type:education.
//   - Wikidata CirrusSearch with a prefix wildcard (`dough*`) scoped to school
//     entity types — matches partial prefixes against school names ("dough" →
//     Dougherty Valley High School) and adds high schools OpenAlex lacks.
// One source failing still returns the other; only 502 if BOTH fail.

// Exact P31 (instance-of) values that cover the common school/university types.
// CirrusSearch haswbstatement doesn't expand subclasses, so we OR a curated list.
const SCHOOL_TYPE_FILTER = [
  'Q3918',   // university
  'Q189004', // college
  'Q38723',  // higher education institution
  'Q9826',   // high school
  'Q159334', // secondary school
  'Q3914',   // school
  'Q2385804',// educational institution
  'Q875538', // public university
  'Q902104', // private university
  'Q4671277',// academic institution
].map((t) => `P31=${t}`).join('|');

function schoolsWikidataUrl(q) {
  // `q*` = prefix-token match; haswbstatement scopes to school types.
  const srsearch = `${q}* haswbstatement:${SCHOOL_TYPE_FILTER}`;
  const params = new URLSearchParams({
    action: 'query', format: 'json', generator: 'search',
    gsrsearch: srsearch, gsrlimit: '12', prop: 'entityterms', wbetlanguage: 'en',
  });
  return `https://www.wikidata.org/w/api.php?${params}`;
}

app.get('/api/schools', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 1) return res.status(400).json({ error: 'Query is required' });

    const sources = [oaFetch(`/autocomplete/institutions?q=${encodeURIComponent(q)}&filter=type:education`)];
    // Wildcards on a single character are too broad/expensive; OpenAlex covers 1-char.
    if (q.length >= 2) sources.push(wdFetch(schoolsWikidataUrl(q)));
    const [oa, wd] = await Promise.allSettled(sources);
    if (oa.status !== 'fulfilled' && (!wd || wd.status !== 'fulfilled')) {
      throw new Error(wd?.reason?.message || oa.reason?.message || 'both upstreams failed');
    }

    const seen = new Set();
    const results = [];
    const add = (name, hint, id, qid) => {
      if (!name || /^Q\d+$/.test(name) || name.startsWith('Category:')) return;
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      results.push({ name, hint: hint || '', id: id || '', qid: qid || '' });
    };
    // OpenAlex first (well-ranked prefix matches, with city/country hints + an
    // institution id), then Wikidata (adds high schools, carrying its QID).
    if (oa.status === 'fulfilled') {
      for (const r of oa.value.results || []) add(r.display_name, r.hint, stripId(r.id), '');
    }
    if (wd && wd.status === 'fulfilled') {
      const pages = Object.values(wd.value?.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
      for (const p of pages) add(p.entityterms?.label?.[0], '', '', p.title);
    }
    const out = results.slice(0, 12);

    // Attach institution coordinates (best-effort, durably cached) so the client can
    // capture them at pick time and the recommender can boost nearby professors. A
    // geo failure degrades to id/qid-only — it must never 502 the autocomplete.
    try {
      const oaIds = out.map((r) => r.id).filter(Boolean);
      const wdQids = out.filter((r) => !r.id).map((r) => r.qid).filter(Boolean);
      const [instGeo, wdGeo] = await Promise.all([
        oaIds.length ? resolveInstitutionGeos(oaIds) : new Map(),
        wdQids.length ? resolveWikidataCoords(wdQids) : new Map(),
      ]);
      for (const r of out) {
        const g = (r.id && instGeo.get(r.id)) || (r.qid && wdGeo.get(r.qid)) || null;
        if (g) { r.lat = g.lat; r.lng = g.lng; r.country = g.country || ''; }
      }
    } catch { /* geo optional — return id/qid without coords */ }

    res.json({ query: q, results: out });
  } catch (err) {
    console.error('[/api/schools]', err.message);
    res.status(502).json({ error: 'Failed to reach institution sources', detail: err.message });
  }
});

// ─── Resume analysis constants ────────────────────────────────────────────────
const ALLOWED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'application/pdf']);


const RESUME_SYSTEM =
  'You are a resume analyser. Always respond with a single valid JSON object and nothing else — ' +
  'no markdown, no code fences, no prose before or after the JSON.';

const DRAFT_SYSTEM =
  'You are an expert academic writing assistant. You write concise, genuine, specific cold-outreach ' +
  'emails from a prospective graduate student or research assistant to a professor. The emails are ' +
  'warm but professional, never sycophantic or generic. They reference the professor\'s actual recent ' +
  'work, connect it to the sender\'s background, and end with a clear, low-pressure ask. ' +
  'Respond with ONLY a single JSON object {"subject": string, "body": string} — no markdown, no code fences.';

const RESUME_PROMPT =
  'Look at this document. First decide: is it a resume or CV? ' +
  'Read the ENTIRE document carefully — including any sidebars or multi-column layouts (a styled ' +
  'resume often puts skills, certifications, or extra sections in a side column) and every section ' +
  '(Summary, Experience, Education, Certifications, Skills, etc.). Do not skip a column or section.\n' +
  'Return a JSON object with exactly these keys:\n' +
  '  "isResume": true if it is clearly a resume or CV, otherwise false\n' +
  '  "name": the person\'s full name (empty string if not a resume or not found)\n' +
  '  "institution": their current or most recent school / university / institution ' +
  '(empty string if none found)\n' +
  '  "field": their primary academic field in a few words, e.g. "Computer Science" ' +
  '(empty string if not a resume)\n' +
  '  "goal": a concise statement of the research or career goal they appear to be pursuing next, ' +
  'e.g. "Land a research internship in machine learning" — infer from their objective, summary, or ' +
  'background. Empty string if not a resume.\n' +
  '  "interests": array of academic research fields/topics the person is strongest in, ordered strongest-first ' +
  '(empty array if not a resume)\n' +
  '  "summary": one sentence summarising their research background (empty string if not a resume)\n' +
  '  "sellingPoints": array of up to 3 short phrases (max ~12 words each) capturing what makes this person ' +
  'a strong research candidate — concrete skills, built systems, or strengths a professor would value. ' +
  'Empty array if not a resume.\n' +
  '  "accomplishments": array of DISTINCT, concise achievements (max ~12 words each) — the person\'s ' +
  'STRONGEST, most impressive achievements: the ones that would look best in a cold outreach email ' +
  'to a professor and make them stand out. Prioritize prestigious awards/honors, publications, ' +
  'advanced degrees, selective programs, leadership, and high-impact quantified results ' +
  '(percentages, dollar amounts, efficiency gains). Quality over quantity — include ONLY genuinely ' +
  'impressive items, ordered strongest-first; typically 3-5, never more than 5. Skip routine duties ' +
  'and weak filler. Each entry must be a DIFFERENT achievement — do NOT restate the same one. Lead ' +
  'with the achievement, keep it simple. Empty array if not a resume.\n' +
  'Example: {"isResume":true,' +
  '"interests":["machine learning","computer vision"],' +
  '"name":"Jane Doe","institution":"Stanford University","field":"Computer Science",' +
  '"goal":"Secure a machine-learning research internship",' +
  '"summary":"PhD candidate in deep learning with a focus on image recognition.",' +
  '"sellingPoints":["Built a real-time object detection pipeline in PyTorch","Strong C++/CUDA systems background"],' +
  '"accomplishments":["First-author paper at CVPR 2025","3.9 GPA, Dean\'s List",' +
  '"Cut data-pipeline runtime 40% via caching","Led a 5-person research team"]}';

const MERGE_SYSTEM =
  'You are a profile-merge assistant. You combine a user\'s EXISTING saved profile with an INCOMING ' +
  'resume analysis into ONE unified profile. You KEEP everything substantive the user already has and ' +
  'ADD every genuinely new item the resume brings — the profile should GROW when the resume has more. ' +
  'You only collapse true duplicates, may enrich wording using facts already present in the inputs, ' +
  'and NEVER invent facts. Always respond with a single valid JSON object and nothing else — no ' +
  'markdown, no code fences, no prose.';

const MERGE_PROMPT =
  'Combine the EXISTING profile and the INCOMING resume analysis below into ONE unified profile. ' +
  'The core principle: KEEP everything substantive the user already has, and ADD every genuinely new ' +
  'item the resume brings. If the resume has more than the profile, the combined profile should be ' +
  'BIGGER — just add the new material. Do NOT trim, prune, or restrict to a "best few" for brevity. ' +
  'The only things you remove are true duplicates.\n' +
  'Apply semantic dedupe across BOTH sources: e.g. "ML" and "machine learning" collapse to one entry; ' +
  'accomplishments that are rephrasings of the same achievement collapse to one (keep the strongest / ' +
  'most quantified wording). Two DIFFERENT items are never collapsed — when in doubt, keep both.\n' +
  'You MAY enrich wording: combine related facts and add context to make an item stronger — e.g. fold ' +
  'a quantified result stated elsewhere in the inputs into the accomplishment it describes. Use ONLY ' +
  'facts that appear in the EXISTING profile or the INCOMING resume. NEVER invent, infer, or embellish ' +
  'any fact, metric, title, date, or credential that is not present in the inputs — these go into real ' +
  'outreach emails to professors.\n' +
  'Return a JSON object with exactly these keys:\n' +
  '  "name": prefer the EXISTING value when it is non-empty (it is the user\'s curated value); use the ' +
  'incoming value only to fill a blank.\n' +
  '  "institution": prefer the EXISTING value when non-empty; use incoming only to fill a blank.\n' +
  '  "field": the single best field (a string) representing the COMBINED profile; prefer keeping the ' +
  'existing field when it is still their primary area.\n' +
  '  "goals": an ARRAY of goals — the union of the existing goal(s) and the incoming goal(s), ' +
  'distinct. Keep every distinct goal.\n' +
  '  "interests": an array — the UNION of both interest lists, semantically deduped, strongest-first. ' +
  'Keep every distinct interest; add all new ones from the resume.\n' +
  '  "accomplishments": an array — the UNION of both accomplishment lists, semantically deduped, with ' +
  'grounded richer wording, strongest-first. Add every genuinely new achievement from the resume; ' +
  'keep the impressive existing ones. Skip only an item that is pure filler with no signal.\n' +
  '  "summary": ONE merged sentence reflecting the combined background.\n' +
  '  "sellingPoints": an array — the UNION of selling points across both sources, deduped, ' +
  'strongest-first.\n' +
  'All values are FREE TEXT — do NOT constrain to any fixed catalog.\n' +
  'Respond with ONLY a single JSON object, no markdown, no code fences.\n' +
  'EXISTING profile:\n%EXISTING%\n\n' +
  'INCOMING resume analysis:\n%INCOMING%';

// Best-effort dedupe for free-text achievement lists: collapse entries that are
// rephrasings of the same achievement (share ≥2 significant tokens, or one's tokens
// mostly cover the other's) and keep the shortest wording. Heuristic — the prompt does
// the heavy lifting; this is insurance.
const ACC_STOP = new Set(['with','and','the','for','from','that','this','your','their','over','into',
  'a','an','of','in','on','to','at','as','by','app','project','projects','development','developed',
  'develop','built','build','building','founded','founding','current','currently','active','completed',
  'completion','complete','present','year','years','using','via','plus']);
function accTokens(s) {
  return new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !ACC_STOP.has(w)));
}
function dedupeAchievements(list, cap = 4) {
  const kept = []; // { text, tokens }
  for (const raw of list || []) {
    const text = String(raw).trim();
    if (!text) continue;
    const tokens = accTokens(text);
    let merged = false;
    for (const k of kept) {
      let shared = 0;
      for (const w of tokens) if (k.tokens.has(w)) shared++;
      const minSize = Math.min(tokens.size, k.tokens.size) || 1;
      if (shared >= 2 || shared / minSize >= 0.6) {
        if (text.length < k.text.length) { k.text = text; k.tokens = tokens; }
        merged = true;
        break;
      }
    }
    if (!merged) kept.push({ text, tokens });
  }
  return kept.slice(0, cap).map(k => k.text);
}

/**
 * Analyse a resume image or PDF and suggest matching professors.
 *
 * POST /api/analyze-resume
 * Auth: REQUIRED — `Authorization: Bearer <Firebase ID token>`. Missing/invalid → 401.
 * Rate limit: 1 upload per account per UTC day. A 2nd same-day call → 429 with a
 *   `Retry-After` (seconds) header and `{ error, resetAt, limit: 1 }`. The slot is
 *   reserved AFTER input validation but BEFORE Claude, and refunded only when the
 *   failure is ours/Claude's (malformed-JSON or upstream 502); a successful 200 and
 *   the "not a resume" 400 both consume the day's slot.
 * Body: { data: "<base64>", mediaType: "image/png" | "image/jpeg" | "application/pdf" }
 *
 * Response: { interests: string[], summary: string,
 *             sellingPoints: string[], accomplishments: string[],
 *             name: string, institution: string, field: string, goal: string,
 *             professors: Professor[] }
 *
 * The file is never persisted — it is sent to Claude, interests extracted, then discarded.
 */
app.post('/api/analyze-resume', async (req, res) => {
  // ── Auth first ───────────────────────────────────────────────────────────────
  // A missing/expired token never reaches input validation, a slot, or Claude.
  let uid;
  try {
    ({ uid } = await verifyFirebaseToken(req.headers.authorization));
  } catch {
    return res.status(401).json({ error: 'Please sign in to analyze a résumé.' });
  }

  try {
    const { data, mediaType } = req.body || {};

    // ── Validate input ────────────────────────────────────────────────────────
    // Runs before the slot reservation so a malformed request never burns a slot.
    if (!data || typeof data !== 'string' || data.length < 100) {
      return res.status(400).json({ error: 'Missing or too-small `data` field (base64 string required).' });
    }
    if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
      return res.status(400).json({
        error: `Unsupported mediaType "${mediaType}". Allowed: image/png, image/jpeg, application/pdf.`,
      });
    }

    // ── Reserve the day's single slot BEFORE spending a Claude call ───────────
    const reservation = await reserveDailyUpload(uid);
    if (!reservation.ok) {
      res.set('Retry-After', String(Math.ceil(msUntilNextUtcMidnight() / 1000)));
      return res.status(429).json({
        error: 'Max daily limit reached — come back tomorrow.',
        resetAt: reservation.resetAt,
        limit: 1,
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
      max_tokens: 1280,
      system: RESUME_SYSTEM,
      messages: [{ role: 'user', content }],
    });

    let extracted;
    try {
      const rawText = (message.content.find(b => b.type === 'text')?.text || '{}')
        .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      extracted = JSON.parse(rawText);
    } catch {
      // Our/Claude's fault — refund the slot so the user isn't charged for it.
      await refundDailyUpload(uid);
      return res.status(502).json({ error: 'Claude returned malformed JSON.', raw: message.content });
    }

    if (!extracted.isResume) {
      // A valid Claude call that ruled the upload out — consumes the day's slot (no
      // refund). `slotConsumed` lets the client record today's date and keep its local
      // gate in sync (the input-validation 400s above never set it — they reserve nothing).
      return res.status(400).json({ error: 'This doesn\'t look like a resume. Please upload a resume or CV.', slotConsumed: true });
    }

    // Cap interests to top 3 for the matching step.
    const interests = (extracted.interests || []).slice(0, 3).filter(Boolean);
    const summary = extracted.summary || '';
    const sellingPoints = (extracted.sellingPoints || []).slice(0, 4).filter(Boolean);
    const accomplishments = dedupeAchievements(extracted.accomplishments, 5);
    // Profile-memory fields (single-value); empty string when not found.
    const name = (extracted.name || '').toString().trim();
    const institution = (extracted.institution || '').toString().trim();
    const field = (extracted.field || '').toString().trim();
    const goal = (extracted.goal || '').toString().trim();

    if (!interests.length) {
      return res.json({ interests: [], summary, sellingPoints, accomplishments,
        name, institution, field, goal, professors: [] });
    }

    // ── Match professors via the shared reply-fit engine ─────────────────────
    // Resume and saved-profile recommendations rank through ONE engine: it infers
    // the dominant field across [field, ...interests], fans out per bucket, dedupes,
    // and scores each survivor with the reply-fit blend (matchScore + breakdown).
    //
    // Scoped try/catch ON PURPOSE: Claude has already run, been billed, and produced a
    // usable profile by this point. If the downstream OpenAlex matching fails (e.g. an
    // upstream outage) we must NOT bubble to the outer catch — that refunds the slot and
    // would let the user re-upload (re-billing Claude) repeatedly during an outage, so
    // the cap never engages. Keep the slot consumed and degrade to a no-matches 200; the
    // client handles an empty `professors` list. (Claude-call failures throw earlier, at
    // anthropic.messages.create, before extraction — those still hit the outer catch and
    // refund, since no usable profile was produced.)
    let professors = [];
    try {
      professors = await recommendForInterests(interests, { field, goal, limit: 90 });
    } catch (matchErr) {
      console.error('[/api/analyze-resume] matching failed, returning profile with no matches:', matchErr.message);
    }

    res.json({ interests, summary, sellingPoints, accomplishments,
      name, institution, field, goal, professors });
  } catch (err) {
    console.error('[/api/analyze-resume]', err.message);
    // Any failure that reaches here is ours/Claude's (the slot was already reserved
    // by this point) — refund it before responding so the user isn't charged.
    await refundDailyUpload(uid);
    if (err.status === 401) {
      return res.status(502).json({ error: 'Invalid or missing ANTHROPIC_API_KEY on the server.' });
    }
    res.status(502).json({ error: 'Resume analysis failed.', detail: err.message });
  }
});

/**
 * Profile-driven reply-fit recommendations (no AI, no file upload).
 *
 * POST /api/recommend
 * Body: { interests: string[], field?: string, goal?: string,
 *         unis?: string[] (OpenAlex ids), limit?: number }
 *
 * Response: { interests: string[], goal: string,
 *             professors: [{ ...card, matchScore: 30–99, breakdown }] }
 *
 * Shares the reply-fit engine with /api/analyze-resume, so the saved profile and a
 * resume rank professors identically. Deterministic — runs entirely over fields
 * OpenAlex already returns.
 */
app.post('/api/recommend', async (req, res) => {
  try {
    const body = req.body || {};

    // ── Validate input ────────────────────────────────────────────────────────
    const interests = (Array.isArray(body.interests) ? body.interests : [])
      .map((s) => String(s ?? '').trim())
      .filter(Boolean)
      .slice(0, 12);
    const field = (body.field || '').toString().trim();
    const goal = (body.goal || '').toString().trim();

    // Need at least one interest OR a declared field to score against.
    if (!interests.length && !field) {
      return res.status(400).json({ error: 'Provide at least one interest or a field.' });
    }

    // Sanitize uni filter to OpenAlex author/institution-id shape; cap the list.
    const unis = (Array.isArray(body.unis) ? body.unis : [])
      .map((s) => String(s ?? '').trim())
      .filter((s) => /^I\d+$/.test(s))
      .slice(0, 25);

    // Location filter (US states + countries): each token resolves SERVER-SIDE to
    // institution ids, unioned with `unis`. Bad/unknown tokens are silently dropped.
    const locations = (Array.isArray(body.locations) ? body.locations : [])
      .map((s) => String(s ?? '').trim().toUpperCase())
      .filter((s) => LOC_RE.test(s) && LOCATION_TOKEN_SET.has(s)).slice(0, 25);
    const locInstIds = await resolveLocations(locations);   // [] when locations empty (no upstream call)
    const mergedUnis = [...new Set([...unis, ...locInstIds])].slice(0, 150);

    // Clamp the result cap to a sane range (default 24, up to 150 so the client
    // can paginate a larger scored set across multiple pages).
    const limit = Math.min(150, Math.max(1, parseInt(body.limit, 10) || 24));

    // Student institution → coordinates for the location-proximity boost. Most
    // trusted source first; all optional; all soft-fail to null (proximity is an
    // enhancement and must NEVER take down the route — unlike resolveLocations,
    // which is strict because it changes the candidate SET).
    let studentGeo = null;
    const loc = body.institutionLoc;
    if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng) &&
        Math.abs(loc.lat) <= 90 && Math.abs(loc.lng) <= 180) {
      studentGeo = { lat: loc.lat, lng: loc.lng, country: String(loc.country || '') };
    }
    if (!studentGeo) {
      const stuInstId = /^I\d+$/.test(String(body.institutionId || '')) ? String(body.institutionId) : '';
      if (stuInstId) studentGeo = (await resolveInstitutionGeos([stuInstId])).get(stuInstId) || null;
    }
    if (!studentGeo && body.institution) {
      studentGeo = await resolveStudentGeoByName(String(body.institution));
    }

    // ── Match via the shared reply-fit engine ────────────────────────────────
    const professors = await recommendForInterests(interests, { field, goal, unis: mergedUnis, limit, studentGeo });

    res.json({ interests, goal, professors });
  } catch (err) {
    console.error('[/api/recommend]', err.message);
    res.status(502).json({ error: 'Failed to reach OpenAlex', detail: err.message });
  }
});

/**
 * Smartly merge a user's EXISTING saved profile with an INCOMING resume analysis
 * into one combined profile (the "Add to my profile" feature). Text-only — no PDF/image.
 *
 * POST /api/merge-profile
 * Body: { existing: {...profile}, incoming: {...resumeAnalysis} }
 *   - existing: { name, institution, field, goal, interests[], accomplishments[], summary }
 *   - incoming: same shape + sellingPoints[]  (what /api/analyze-resume returns)
 *
 * Response: { name, institution, field, goals: string[], interests: string[],
 *             accomplishments: string[], summary, sellingPoints: string[] }
 *
 * Merge rule: never drop info from either side unless it's a genuine duplicate; prefer the
 * user's existing name/institution/field; union+semantic-dedupe everything else.
 */
const MERGE_STR_CAP = 4000;   // per long free-text field (summary, etc.)
const MERGE_ARR_CAP = 60;     // max array items we forward to Claude
const MERGE_ITEM_CAP = 600;   // max chars per array item

function sanitizeProfile(p) {
  const obj = (p && typeof p === 'object' && !Array.isArray(p)) ? p : {};
  const str = (v) => String(v ?? '').slice(0, MERGE_STR_CAP);
  const arr = (v) => (Array.isArray(v) ? v : [])
    .map(x => String(x ?? '').trim().slice(0, MERGE_ITEM_CAP))
    .filter(Boolean)
    .slice(0, MERGE_ARR_CAP);
  return {
    name: str(obj.name),
    institution: str(obj.institution),
    field: str(obj.field),
    goal: str(obj.goal),
    interests: arr(obj.interests),
    accomplishments: arr(obj.accomplishments),
    summary: str(obj.summary),
    sellingPoints: arr(obj.sellingPoints),
  };
}

app.post('/api/merge-profile', async (req, res) => {
  try {
    // This route only ever carries a few KB of JSON profile text; reject oversized
    // bodies early instead of inheriting the 15 MB limit (meant for base64 PDFs).
    if (Number(req.headers['content-length']) > 256 * 1024) {
      return res.status(400).json({ error: 'Request body too large.' });
    }
    const { existing, incoming } = req.body || {};

    // ── Validate input ────────────────────────────────────────────────────────
    const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
    if (!isObj(existing) || !isObj(incoming)) {
      return res.status(400).json({ error: '`existing` and `incoming` must both be objects.' });
    }

    // Defensively cap/sanitize sizes; lenient on missing sub-fields.
    const safeExisting = sanitizeProfile(existing);
    const safeIncoming = sanitizeProfile(incoming);

    // Single left-to-right pass over the ORIGINAL template with a function
    // replacement: function replacements don't interpret `$` patterns, and a single
    // pass never re-scans inserted text — so user data containing `$&`, `` $` ``, or a
    // literal `%INCOMING%` can't corrupt the prompt or hijack the other placeholder.
    const fills = {
      '%EXISTING%': JSON.stringify(safeExisting),
      '%INCOMING%': JSON.stringify(safeIncoming),
    };
    const prompt = MERGE_PROMPT.replace(/%EXISTING%|%INCOMING%/g, m => fills[m]);

    // ── Call Claude ──────────────────────────────────────────────────────────
    const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: MERGE_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    });

    let merged;
    try {
      const rawText = (message.content.find(b => b.type === 'text')?.text || '{}')
        .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      merged = JSON.parse(rawText);
    } catch {
      return res.status(502).json({ error: 'Claude returned malformed JSON.', raw: message.content });
    }

    // ── Normalize to the contract shape ──────────────────────────────────────
    const cleanArr = (v, cap) => (Array.isArray(v) ? v : [])
      .map(x => String(x ?? '').trim()).filter(Boolean).slice(0, cap);

    // Single-value fields: cap length — the fallbacks pull from sanitized input
    // (up to MERGE_STR_CAP), which would otherwise bypass single-value sizing.
    const one = (v, fb1, fb2, cap = 200) =>
      (String(v ?? '').trim() || fb1 || fb2 || '').slice(0, cap);
    const name = one(merged.name, safeExisting.name, safeIncoming.name);
    const institution = one(merged.institution, safeExisting.institution, safeIncoming.institution);
    const field = one(merged.field, safeExisting.field, safeIncoming.field);
    // Merge is additive — keep generous caps so growth from the resume isn't clipped.
    const goals = cleanArr(merged.goals, 3);
    const interests = cleanArr(merged.interests, 12);
    // Do NOT run dedupeAchievements here: its token-overlap heuristic wrongly collapses
    // distinct items (e.g. two first-author 2025 papers at different venues). The LLM
    // already semantic-deduped; just clean + cap.
    const accomplishments = cleanArr(merged.accomplishments, 10);
    const summary = String(merged.summary ?? '').trim().slice(0, 600);
    const sellingPoints = cleanArr(merged.sellingPoints, 6);

    res.json({ name, institution, field, goals, interests, accomplishments, summary, sellingPoints });
  } catch (err) {
    console.error('[/api/merge-profile]', err.message);
    if (err.status === 401) {
      return res.status(502).json({ error: 'Invalid or missing ANTHROPIC_API_KEY on the server.' });
    }
    res.status(502).json({ error: 'Profile merge failed.', detail: err.message });
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
    // Scouting stats for a student sizing up the professor (h-index, activity…).
    profile.stats = buildAuthorStats(authorData);
    // normalizeAuthor also attaches dominantField as an internal scoring input; it's
    // not part of the profile DTO, so drop it (scored recommend cards strip it too).
    delete profile.dominantField;

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
      'best_oa_location,open_access,cited_by_count,topics,abstract_inverted_index';

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
      const oaPdfUrl =
        (w.best_oa_location && w.best_oa_location.pdf_url) ||
        (w.primary_location && w.primary_location.pdf_url) ||
        null;
      // Canonical "open the paper" link: DOI → publisher landing → OA landing →
      // OA pdf → OpenAlex page (always present as a last resort).
      const url =
        (w.ids && w.ids.doi) ||
        (w.primary_location && w.primary_location.landing_page_url) ||
        (w.best_oa_location && w.best_oa_location.landing_page_url) ||
        oaPdfUrl ||
        `https://openalex.org/${id}`;
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
        oaPdfUrl,
        isOpenAccess: (w.open_access && w.open_access.is_oa) || false,
        abstract: reconstructAbstract(w.abstract_inverted_index),
        url,
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
 * Rank a professor's RECENT papers by how well each matches a student's WHOLE
 * profile — interests + skills + accomplishments + field + summary — to seed a
 * frontend "Write your email" guide. Deterministic — no AI.
 *
 * POST /api/professor/:authorId/email-guide
 * Body (all optional):
 *   { interests?: string[], field?: string, skills?: string[],
 *     accomplishments?: string[], summary?: string }
 * Response:
 *   { authorId,
 *     hook:    { paperId, title, year, matchedTopic, matchedSource, ranked } | null,  // === matches[0]
 *     matches: [ { paperId, title, year, matchedTopic, matchedSource, ranked } ] }     // top 3
 *   matchedSource: 'field' | 'interest' | 'skill' | null — which student bucket
 *   produced matchedTopic (declared field / an interest / a skill). null for the
 *   most-recent fallback matches and any ranked match whose matchedTopic is null.
 *
 * Reuses the reply-fit matching path, now BLENDED with keyword overlap over the
 * student's interests/skills/accomplishments so the match reflects the whole profile,
 * not just declared interests:
 *   1. Topic-id fit — resolves the BROADENED bucket list [field, ...interests,
 *      ...skills] (deduped, capped at 8) via pickDominantField + resolveTopicId, and
 *      takes the MAX computeMatchScore(paper.topics, citedByCount, target) across them
 *      (the same reply-fit topical signal recommendForInterests uses).
 *   2. Text overlap — counts distinct keyword overlaps between a STUDENT keyword bag
 *      (interests + skills + accomplishments + field + summary, tokenized via accTokens)
 *      and a PER-PAPER text bag (title + topic/field/subfield names + the reconstructed
 *      abstract). Title/topic hits weigh more than abstract hits, so a genuine skill or
 *      accomplishment overlap demonstrably reorders papers.
 * relevance = (maxMatchScore - 50) + textOverlapScore * W. Sort desc, tiebreak most
 * recent (candidates are most-recent-first, so a strict > preserves recency). Top 3.
 *
 * Falls back to the top-3 MOST-RECENT papers (ranked:false) when there's no usable
 * profile signal (no resolved targets AND empty keyword bag, or no paper carries any
 * topics/text to match). No papers at all → { matches: [], hook: null }.
 *
 * paperId is the SHORT OpenAlex work id (shortId — same normalization as /papers'
 * toPaper), so the frontend's _papersById lookup matches. hook === matches[0]
 * (back-compat for the email-guide hook block), or null when there are no papers.
 */
app.post('/api/professor/:authorId/email-guide', async (req, res) => {
  try {
    const { authorId } = req.params;
    const fullId = authorId.startsWith('A') ? authorId : `A${authorId}`;

    const body = req.body || {};
    if (typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Malformed body: expected an object.' });
    }
    const strList = (v) =>
      (Array.isArray(v) ? v : []).map((s) => String(s).trim()).filter(Boolean);
    const interestList = strList(body.interests);
    const skillList = strList(body.skills);
    const accList = strList(body.accomplishments);
    const fieldStr = (body.field || '').toString().trim();
    const summaryStr = (body.summary || '').toString().trim();

    // RECENT works only — same fetch shape as /papers' recent query (incl. topics +
    // abstract), cached by oaFetch. We rank within this recent bucket, not lifetime.
    const SELECT =
      'id,ids,title,publication_year,publication_date,type,primary_location,' +
      'best_oa_location,open_access,cited_by_count,topics,abstract_inverted_index';
    const recentData = await oaFetch(
      `/works?filter=author.id:${fullId}&sort=publication_date:desc&per_page=25&select=${SELECT}`
    );

    const raws = recentData.results || [];
    if (!raws.length) {
      return res.json({ authorId: fullId, hook: null, matches: [] });
    }

    // Each candidate: short id + cleaned title + raw topics[] (dropped by /papers'
    // public toPaper DTO) + a precomputed text-bag token Set for keyword overlap.
    // Sorted most-recent-first so it doubles as the recency tiebreak + fallback order.
    const dateKey = (w) => w.publication_date || (w.publication_year ? `${w.publication_year}-00-00` : '');
    const candidates = raws
      .map((w) => {
        const topics = w.topics || [];
        // PER-PAPER text bag: title + topic/field/subfield display_names get folded
        // into a "strong" token set (weighted higher), the abstract into a "weak" one.
        const strongText = [
          w.title || '',
          ...topics.flatMap((t) => [
            t.display_name || '',
            t.field?.display_name || '',
            t.subfield?.display_name || '',
          ]),
        ].join(' ');
        const abstract = reconstructAbstract(w.abstract_inverted_index) || '';
        return {
          id: shortId(w.id),
          title: w.title || 'Untitled',
          year: w.publication_year || null,
          // NOTE: WORK topics carry no `count`, so computeMatchScore's sharePart is
          // always 0 — paper ranking rests on topic rank + field/subfield overlap +
          // citation bonus. Don't assume the share-of-output term is live.
          topics,
          citedByCount: w.cited_by_count || 0,
          strongTokens: accTokens(strongText),
          weakTokens: accTokens(abstract),
          dateKey: dateKey(w),
        };
      })
      .sort((a, b) => b.dateKey.localeCompare(a.dateKey));

    const toMatch = (c, matchedTopic, matchedSource, ranked) => ({
      paperId: c.id,
      title: c.title,
      year: c.year,
      matchedTopic,
      // Which student bucket produced matchedTopic: 'field'|'interest'|'skill', or
      // null for fallback matches and any ranked match whose matchedTopic is null.
      matchedSource,
      ranked,
    });
    // Fallback: top-3 most-recent papers, ranked:false. hook === matches[0].
    const fallback = () => {
      const matches = candidates.slice(0, 3).map((c) => toMatch(c, null, null, false));
      res.json({ authorId: fullId, hook: matches[0] || null, matches });
    };

    // BROADENED bucket list: field + interests + skills (skills resolve well to
    // OpenAlex topics too). Dedupe case-insensitively, cap at 8 to bound the
    // resolveTopicId fan-out. Each retained entry carries its source bucket
    // ({ term, source }) so a downstream match can report WHICH student bucket
    // produced it — fieldStr → 'field', interests → 'interest', skills → 'skill'.
    // First occurrence wins on dedupe (so 'field' beats a later 'interest'/'skill').
    const bucketSeen = new Set();
    const all = [];
    const sourced = [
      ...(fieldStr ? [{ term: fieldStr, source: 'field' }] : []),
      ...interestList.map((term) => ({ term, source: 'interest' })),
      ...skillList.map((term) => ({ term, source: 'skill' })),
    ];
    for (const b of sourced) {
      const key = b.term.toLowerCase();
      if (bucketSeen.has(key)) continue;
      bucketSeen.add(key);
      all.push(b);
      if (all.length >= 8) break;
    }

    // STUDENT keyword bag for text overlap: interests + skills + accomplishments +
    // field + summary, tokenized/stopworded via the existing accTokens helper.
    const studentTokens = accTokens(
      [...interestList, ...skillList, ...accList, fieldStr, summaryStr].join(' ')
    );

    // No usable signal at all → most-recent fallback.
    if (!all.length && studentTokens.size === 0) return fallback();

    // Resolve each bucket to a scoring target { topicId, fieldId, subfieldId, source },
    // biased toward the student's dominant field (same path the recommend engine uses).
    // `resolved` is Promise.all over `all` IN ORDER, so index alignment with `all`
    // holds — we carry each bucket's `source` onto its target before filtering.
    let targets = [];
    if (all.length) {
      const dominantFieldId = await pickDominantField(all.map((b) => b.term));
      const resolved = await Promise.all(
        all.map((b) => resolveTopicId(b.term, dominantFieldId).catch(() => null))
      );
      targets = resolved
        .map((r, i) => ({ r, source: all[i].source }))
        .filter(({ r }) => r && r.id)
        .map(({ r, source }) => ({
          topicId: r.id,
          fieldId: r.fieldId,
          subfieldId: r.subfieldId,
          source,
        }));
    }

    // Nothing left to match on (no targets AND no keyword bag, or no paper carries
    // topics/text) → most-recent fallback.
    const anyPaperText = candidates.some(
      (c) => c.topics.length || c.strongTokens.size || c.weakTokens.size
    );
    if ((!targets.length && studentTokens.size === 0) || !anyPaperText) return fallback();

    // Weight on the text-overlap term. The topical portion (maxMatchScore - 50) spans
    // ~0..47; W=6 means ~8 strong keyword overlaps rival a full topical match, so a
    // handful of genuine skill/accomplishment overlaps meaningfully reorders papers
    // while a strong topical match still ranks high.
    const W = 6;
    const STRONG_W = 2; // title/topic-name overlap weighs double an abstract overlap.

    // Score each recent paper: topical MAX across targets blended with weighted text
    // overlap. Track the professor-topic display_name driving the best target so the
    // frontend can hint the connection.
    const scored = candidates.map((c) => {
      // Topical portion: MAX computeMatchScore across targets (0 above-floor when no
      // targets), plus the matchedTopic that drove the winner and the student bucket
      // (matchedSource: 'field'|'interest'|'skill') that target came from.
      let bestBase = 0; // above-floor (matchScore - 50); 0 when no targets match
      let matchedTopic = null;
      let matchedSource = null;
      for (const t of targets) {
        const score = computeMatchScore(c.topics, c.citedByCount, t);
        const above = Math.max(0, score - 50);
        if (above >= bestBase) {
          const hit = c.topics.find((pt) => stripId(pt.id) === t.topicId);
          // Prefer a topic-backed hit when scores tie so matchedTopic stays meaningful.
          if (above > bestBase || (hit && !matchedTopic)) {
            // Keep source paired with the topic that actually drove the win.
            matchedTopic = hit ? hit.display_name : matchedTopic;
            matchedSource = hit ? t.source : matchedSource;
          }
          bestBase = above;
        }
      }

      // Text-overlap portion: distinct student tokens hitting strong/weak paper bags.
      let strongHits = 0;
      let weakHits = 0;
      for (const tok of studentTokens) {
        if (c.strongTokens.has(tok)) strongHits++;
        else if (c.weakTokens.has(tok)) weakHits++;
      }
      const textOverlap = strongHits * STRONG_W + weakHits;

      const relevance = bestBase + textOverlap * W;
      return { candidate: c, relevance, matchedTopic, matchedSource };
    });

    // Sort by relevance desc; candidates are already most-recent-first, so a stable
    // sort with strict desc comparison keeps the recency tiebreak.
    const ranked = scored.slice().sort((a, b) => b.relevance - a.relevance);

    // If nothing scored above zero, there was no real signal → most-recent fallback.
    if (!ranked.length || ranked[0].relevance <= 0) return fallback();

    const matches = ranked
      .slice(0, 3)
      .map((r) => toMatch(r.candidate, r.matchedTopic, r.matchedSource, true));
    res.json({ authorId: fullId, hook: matches[0] || null, matches });
  } catch (err) {
    console.error('[/api/professor/:authorId/email-guide]', err.message);
    res.status(502).json({ error: 'Failed to reach OpenAlex', detail: err.message });
  }
});

/**
 * Draft a personalized cold-outreach email to a professor, with AI.
 *
 * POST /api/professor/:authorId/draft-email
 * Body (all optional): { student: { name, summary, interests: string[], sellingPoints: string[] } }
 * Response: { subject, body, professor: { name, institution } }
 *
 * Pulls the professor's recent papers (with abstracts) from OpenAlex — cached via
 * oaFetch — and asks Claude to write a concise, specific email that references their
 * actual work and ties it to the sender's background when provided. The student
 * context is whatever the résumé flow already extracted; it is never persisted.
 * Requires ANTHROPIC_API_KEY (else 502, matching /api/analyze-resume).
 */
app.post('/api/professor/:authorId/draft-email', async (req, res) => {
  try {
    const { authorId } = req.params;
    const fullId = authorId.startsWith('A') ? authorId : `A${authorId}`;
    const student = (req.body && req.body.student) || {};

    // Professor profile + recent papers (with abstracts) — both cached by oaFetch.
    const [authorData, worksData] = await Promise.all([
      oaFetch(`/authors/${fullId}`),
      oaFetch(
        `/works?filter=author.id:${fullId}&sort=publication_date:desc&per_page=5` +
        `&select=id,title,publication_year,primary_location,cited_by_count,abstract_inverted_index`
      ),
    ]);

    const profile = normalizeAuthor(authorData, 0, 1);
    const papers = (worksData.results || []).map(normalizeWork);

    // Compact context: top 3 recent papers (title + a trimmed abstract).
    const paperLines = papers.slice(0, 3).map((p, i) => {
      const abs = (p.abstract || '').replace(/\s+/g, ' ').slice(0, 400);
      return `${i + 1}. "${p.title}"${p.year ? ` (${p.year})` : ''}${p.venue ? `, ${p.venue}` : ''}` +
        (abs ? `\n   Abstract: ${abs}` : '');
    }).join('\n');

    const topics = (authorData.topics || []).slice(0, 6).map(t => t.display_name).filter(Boolean).join(', ');

    // Optional sender context (résumé-derived). Never invent beyond what's given.
    const name = typeof student.name === 'string' ? student.name.trim() : '';
    const summary = typeof student.summary === 'string' ? student.summary.trim() : '';
    const interests = Array.isArray(student.interests) ? student.interests.filter(Boolean).slice(0, 4) : [];
    const sellingPoints = Array.isArray(student.sellingPoints) ? student.sellingPoints.filter(Boolean).slice(0, 4) : [];

    const hasSender = name || summary || interests.length || sellingPoints.length;
    const senderBlock = hasSender
      ? [
          'SENDER BACKGROUND (personalize from this; do not invent credentials beyond it):',
          name ? `- Name: ${name}` : '- Name: not given — sign off with "[Your name]".',
          summary ? `- Summary: ${summary}` : '',
          interests.length ? `- Research interests: ${interests.join(', ')}` : '',
          sellingPoints.length ? `- Strengths: ${sellingPoints.join('; ')}` : '',
        ].filter(Boolean).join('\n')
      : 'SENDER BACKGROUND: none provided. Write a strong general prospective-student email and use ' +
        '"[Your name]" and "[a sentence about your background]" placeholders where personal detail is needed.';

    const userPrompt =
      `Write a cold outreach email to Professor ${profile.name}` +
      `${profile.institution ? ` at ${profile.institution}` : ''}.\n\n` +
      `PROFESSOR'S RESEARCH AREAS: ${topics || 'unknown'}\n\n` +
      `PROFESSOR'S RECENT PAPERS:\n${paperLines || 'No recent papers available.'}\n\n` +
      `${senderBlock}\n\n` +
      'Requirements:\n' +
      '- Reference ONE or TWO of the specific papers above by what they actually study (paraphrase; do not just repeat the title).\n' +
      '- Keep the body under 160 words.\n' +
      '- Open with a specific hook — never "I hope this email finds you well".\n' +
      '- Tie the professor\'s work to the sender\'s interests/strengths.\n' +
      '- End with a clear, low-pressure ask (a brief meeting, or about PhD/RA openings).\n' +
      '- Subject line: short and specific, no clickbait.';

    const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      system: DRAFT_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
    });

    let draft;
    try {
      const rawText = (message.content.find(b => b.type === 'text')?.text || '{}')
        .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      draft = JSON.parse(rawText);
    } catch {
      return res.status(502).json({ error: 'Claude returned malformed JSON.' });
    }

    res.json({
      subject: (draft.subject || 'Interest in your research').trim(),
      body: (draft.body || '').trim(),
      professor: { name: profile.name, institution: profile.institution },
    });
  } catch (err) {
    console.error('[/api/professor/:authorId/draft-email]', err.message);
    if (err.status === 401) {
      return res.status(502).json({ error: 'Invalid or missing ANTHROPIC_API_KEY on the server.' });
    }
    res.status(502).json({ error: 'Email drafting failed.', detail: err.message });
  }
});

/**
 * Discover a professor's email address from free public sources, on demand.
 *
 * GET /api/professor/:authorId/email
 * Response: { email, confidence: 'verified'|'likely'|null,
 *             source, mailtoEnabled, facultySearchUrl, candidates }
 *
 * DOI-keyed, all-fields fan-out (NOT a serial cascade):
 *   Layer 1  Europe PMC — JATS <corresp> (verified) / author-affiliation (likely);
 *            plus author-level ORCID public email (verified) added once
 *   Layer 2  Unpaywall landing-page HTML (verified/likely) + the OA PDF parse IN-BAND
 *            (verified/likely) + arXiv PDF (likely) + Crossref author metadata —
 *            works even for paywalled papers (likely). The detached background
 *            upgrade re-parses the OA PDFs and re-caches only a STRICTLY better hit.
 *   Layer 3  institution email-pattern best-guess (confidence:'likely', mailable, source:'institution-pattern')
 * When no verified/likely email is found, fall back to the Layer 3 guess; the
 * facultySearchUrl is always returned as the actionable fallback link.
 * The probes for the top 3–5 recent OA+DOI works fire concurrently; the user-facing
 * wait is capped at PUBLIC_BUDGET_MS via raceForEmail (verified wins instantly).
 * The whole handler is in try/catch and ALWAYS returns 200 with at least a
 * facultySearchUrl — a Firestore/upstream outage must degrade, never throw.
 */
const PUBLIC_BUDGET_MS = 5000; // one EMAIL_FETCH_TIMEOUT_MS (4500) fetch now fits the window

app.get('/api/professor/:authorId/email', async (req, res) => {
  const { authorId } = req.params;

  const payload = {
    email: null,
    confidence: null,
    source: null,
    mailtoEnabled: false,
    facultySearchUrl: null,
    candidates: [],
  };

  // Validate the id BEFORE it touches any upstream URL. An OpenAlex author id is
  // 'A' + digits; anything else (e.g. "A1&filter=…") could inject query params into
  // the /authors and /works?filter= calls. On a bad id, return the standard empty
  // payload at 200 — route-never-errors, so no 400/throw.
  if (!/^A?\d+$/i.test(authorId)) return res.json(payload);
  const fullId = `A${authorId.replace(/^A/i, '')}`;       // canonical, digits-only after 'A'
  const safeId = encodeURIComponent(fullId);              // belt-and-suspenders on interpolation
  const cacheKey = `email:${fullId}`;

  try {
    // Step 0 — durable cache FIRST. Any unexpired hit (positive OR negative, incl.
    // a no-email payload that still carries facultySearchUrl) returns immediately,
    // so a miss is as fast as a hit.
    const hit = await cacheGet(cacheKey);
    if (hit !== undefined) return res.json(hit);

    // Author + works (with DOI). Probing needs the doi + locations for arXiv/OA.
    const [author, worksData] = await Promise.all([
      oaFetch(`/authors/${safeId}`),
      oaFetch(
        `/works?filter=author.id:${safeId}&sort=publication_date:desc&per_page=25` +
        `&select=id,ids,doi,title,type,publication_date,authorships,open_access,best_oa_location,primary_location,locations`
      ),
    ]);

    const name = author.display_name || 'Unknown';
    // Fold accents and normalize Unicode dashes BEFORE stripping non-letters, so
    // "Acemoğlu" → "acemoglu" (not "acemo"+"lu") and "Jarillo‐Herrero" (U+2010 dash)
    // keeps its hyphenated surname instead of collapsing to "Herrero".
    const cleanName = fold(name).replace(/[‐-―−]/g, '-');
    const tokens = cleanName.replace(/[^A-Za-z\s'-]/g, ' ').split(/\s+/).filter(Boolean);
    const first = (tokens[0] || '').toLowerCase();
    const last = (tokens[tokens.length - 1] || '').toLowerCase();

    const works = worksData.results || [];
    // Sustained "home" institution from affiliations[] (last_known[0] is often stale).
    const inst = primaryInstitution(author);
    const institution = inst.display_name || '';

    // facultySearchUrl built EARLY so even a total upstream failure returns a link.
    payload.facultySearchUrl =
      `https://www.google.com/search?q=${encodeURIComponent(`"${name}" ${institution} faculty profile`)}`;

    // Institution domain (ROR domains → OpenAlex homepage → institutionDomain) —
    // used for matchCtx scoring, the Layer 3 guess, and the faculty-search link.
    const ror = (inst && (inst.ror || (inst.ids && inst.ids.ror))) || null;
    const domain = await resolveInstitutionDomain(inst, ror).catch(() => null);
    const matchCtx = { first, last, domain };

    // Scope the faculty search to the institution's own domain once we have it.
    if (domain) {
      payload.facultySearchUrl =
        `https://www.google.com/search?q=${encodeURIComponent(`site:${domain} "${name}"`)}`;
    }

    // Probe set — recent works that are open access AND carry a DOI. Cap at 8; we
    // never probe the whole 25. Each probe carries its derived ids.
    //
    // Two prioritized passes (recency order preserved WITHIN each pass) so the real
    // PMC papers aren't crowded out by preprints/supplementary records that share
    // the recency slots:
    //   pass 1 — works Layer 1 can actually read: a Europe PMC / PubMed Central
    //            location (source S4306400806) OR ones where THIS author is the
    //            corresponding author;
    //   pass 2 — the remaining OA+DOI works.
    // Records that can't carry a useful author email (paratext, supplementary
    // materials, datasets, peer reviews, editorials, errata) are skipped outright.
    const PMC_SOURCE_ID = 'https://openalex.org/S4306400806'; // Europe PMC (PubMed Central)
    const SKIP_TYPES = new Set([
      'paratext', 'supplementary-materials', 'dataset', 'peer-review', 'editorial', 'erratum',
    ]);
    const priority = [];
    const rest = [];
    for (const w of works) {
      if (SKIP_TYPES.has(w.type)) continue;
      const doi = normDoi(w.doi || (w.ids && w.ids.doi));
      if (!doi) continue;
      const oa = (w.open_access && w.open_access.is_oa) || (w.best_oa_location && w.best_oa_location.is_oa) ||
        (w.locations || []).some((l) => l.is_oa);
      if (!oa) continue;
      const entry = { doi, arxiv: arxivIdFromWork(w, doi) };
      const hasPmcLocation = (w.locations || []).some((l) => l.source && l.source.id === PMC_SOURCE_ID);
      const authorIsCorresponding = (w.authorships || []).some(
        (a) => shortId(a.author && a.author.id) === fullId && a.is_corresponding === true
      );
      (hasPmcLocation || authorIsCorresponding ? priority : rest).push(entry);
    }
    const probes = priority.concat(rest).slice(0, 8);

    // Fan-out: for each probe DOI fire Layer 1 (Europe PMC) + Layer 2 (landing page,
    // OA PDF, arXiv) + Crossref concurrently. raceForEmail resolves the instant a
    // `verified` arrives, else returns best-by-confidence at PUBLIC_BUDGET_MS. Pending
    // promises keep running for the post-response background upgrade.
    const probeThunks = [];
    for (const { doi, arxiv } of probes) {
      probeThunks.push(() => probeEuropePmc(doi, matchCtx));
      probeThunks.push(() => probeLandingPage(doi, matchCtx).then((r) =>
        r && r.email ? r : null)); // a {pdfUrl}-only result is not a hit here
      // In-band OA PDF parse: probeLandingPage is already a cached thunk above, so this
      // call is a `page:${doi}` cache hit that yields the pdfUrl; probePdfCached then
      // shares its `pdf:${doi}` parse with the background upgrade.
      probeThunks.push(() => probeLandingPage(doi, matchCtx).then((lp) => {
        const pdfUrl = lp && lp.pdfUrl;
        return pdfUrl ? probePdfCached(doi, pdfUrl, (lp && lp.source) || pdfUrl, matchCtx) : null;
      }));
      // Crossref — works even for PAYWALLED papers (author metadata, no OA needed).
      probeThunks.push(() => probeCrossref(doi, matchCtx));
      if (arxiv) probeThunks.push(() => probeArxiv(arxiv, matchCtx));
    }
    // Layer 1b — author-level PMC. Added ONCE (not per-DOI): probes the author's own
    // OA PubMed Central papers directly so an OLD paper carrying this professor's
    // email is still reached even when it falls outside the recent-works window.
    probeThunks.push(() => probeAuthorPmc(fullId, matchCtx));
    // ORCID — author-level, added ONCE when the author has an ORCID id (author.orcid
    // is a FULL URL; strip to the bare id). A PUBLIC ORCID email is authoritative.
    const orcidId = author.orcid ? String(author.orcid).replace(/^https?:\/\/orcid\.org\//i, '') : null;
    if (orcidId) probeThunks.push(() => probeOrcid(orcidId, matchCtx));

    let best = null;
    if (probeThunks.length) {
      const { result } = raceForEmail(probeThunks, PUBLIC_BUDGET_MS);
      best = await result;
    }

    if (best && best.email) {
      const mailtoEnabled = best.confidence === 'verified' || best.confidence === 'likely';
      Object.assign(payload, {
        email: best.email,
        confidence: best.confidence,
        source: best.source || null,
        mailtoEnabled,
      });
    }
    // Layer 3 — no verified/likely hit: fall back to an institution email-pattern
    // best-guess. Surfaced as `likely` and mailable, but flagged via
    // source:'institution-pattern' so the UI can show a softer "confirm before
    // sending" note. `candidates` carries all 4 patterns.
    if (!payload.email && domain && first && last) {
      const guesses = guessEmails(first, last, domain);
      if (guesses.length) {
        Object.assign(payload, {
          email: guesses[0],
          confidence: 'likely',
          source: 'institution-pattern',
          mailtoEnabled: true,
          candidates: guesses,
          institution, // display name → UI renders "Standard <institution> email format"
        });
      }
    }

    // Persist: verified + real `likely` ~7d; constructed institution-pattern
    // best-guesses and not-found ~2d (re-probe sooner; negatives still carry the
    // facultySearchUrl). Then respond.
    const ttl = (payload.confidence === 'verified'
      || (payload.confidence === 'likely' && payload.source !== 'institution-pattern'))
      ? EMAIL_TTL_VERIFIED_MS : EMAIL_TTL_GUESS_MS;
    await cacheSet(cacheKey, payload, ttl);
    res.json(payload);

    // Background upgrade — after responding, if the result isn't verified, parse the
    // OA PDFs for the probe DOIs off-path (probePdfCached reuses the in-band parse). A
    // STRICTLY better hit rewrites email:{authorId} for the NEXT viewer. Safe in this
    // long-running `node index.js` process; fully detached (no awaiting, errors swallowed).
    if (payload.confidence !== 'verified' && probes.length) {
      // Rank an email result so we only re-cache a genuine improvement over what we
      // already served: verified > a real (non-pattern) likely > a pattern guess /
      // null. A bare `confidence` compare isn't enough — a PDF `likely` must NOT
      // overwrite an already-served real `likely`, but it SHOULD overwrite a
      // `source:'institution-pattern'` guess (also confidence:'likely') or a null.
      const rank = (r) => {
        if (!r || !r.email) return 0;
        if (r.confidence === 'verified') return 3;
        if (r.confidence === 'likely' && r.source !== 'institution-pattern') return 2;
        return 1; // pattern guess
      };
      const servedRank = rank(payload);
      (async () => {
        try {
          for (const { doi } of probes) {
            const lp = await probeLandingPage(doi, matchCtx); // cached; gives us a pdfUrl
            const pdfUrl = lp && lp.pdfUrl;
            if (!pdfUrl) continue;
            const upgraded = await probePdfCached(doi, pdfUrl, lp.source || pdfUrl, matchCtx);
            if (upgraded && upgraded.email && rank(upgraded) > servedRank) {
              const upPayload = {
                ...payload,
                email: upgraded.email,
                confidence: upgraded.confidence,
                source: upgraded.source,
                mailtoEnabled: true, // verified or real likely → always mailable
                candidates: [],
              };
              // Re-read the CURRENT cached value and gate against IT, not our own
              // (stale) servedRank: two cold-miss requests for the same author can
              // race here — without this a PDF `likely` could clobber a `verified`
              // that the other request's background task already wrote. rank(cur)
              // is 0 on a cache miss (rank() returns 0 for falsy/no-email).
              const cur = await cacheGet(cacheKey);
              if (rank(upgraded) > rank(cur)) {
                await cacheSet(cacheKey, upPayload, EMAIL_TTL_VERIFIED_MS);
              }
              if (upgraded.confidence === 'verified') return; // verified is terminal
            }
          }
        } catch { /* background best-effort — never surfaces */ }
      })();
    }
  } catch (err) {
    console.error('[/api/professor/:authorId/email]', err.message);
    // Never 500 the client — return whatever we have (the faculty search link is
    // still actionable even when discovery failed).
    if (!res.headersSent) res.json(payload);
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
 * Quick scouting stats a student actually wants before emailing a professor:
 * impact numbers, how active the lab is *right now*, and whether they can read
 * the work. Pulls only fields already present on the /authors/{id} object.
 */
function buildAuthorStats(raw) {
  const stats = raw.summary_stats || {};
  const byYear = Array.isArray(raw.counts_by_year) ? raw.counts_by_year : [];
  const years = byYear.map((y) => y.year).filter((y) => Number.isFinite(y));
  const firstYear = years.length ? Math.min(...years) : null;
  const lastYear = years.length ? Math.max(...years) : null;

  // Works in the last 3 calendar years — the "is this lab active?" signal.
  const currentYear = new Date().getFullYear();
  const recentWorks = byYear
    .filter((y) => y.year >= currentYear - 2)
    .reduce((s, y) => s + (y.works_count || 0), 0);

  return {
    hIndex: Number.isFinite(stats.h_index) ? stats.h_index : null,
    i10Index: Number.isFinite(stats.i10_index) ? stats.i10_index : null,
    firstYear,
    lastYear,
    recentWorks,
    // True when they've published in the current or previous calendar year.
    active: lastYear != null && lastYear >= currentYear - 1,
  };
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

/**
 * Build a short, useful research summary from available metadata. No AI.
 * Mentions only the ONE primary area (the UI renders all topic chips right
 * below this), and never emits a zero/empty impact stat. Returns null when the
 * author has no topics (unchanged contract).
 */
function buildResearchSummary(raw, profile) {
  const topics = profile.topics;
  if (!topics.length) return null;

  const mainArea = topics[0];
  const inst = profile.institution;
  const hasInst = inst && inst !== 'Independent';

  // Identity + single primary area (+ institution only when known).
  const lead = hasInst
    ? `${profile.name} researches ${mainArea} at ${inst}.`
    : `${profile.name} researches ${mainArea}.`;

  return lead;
}

// ─── Serve frontend ──────────────────────────────────────────────────────────
app.use(express.static(join(__dirname, '..')));

// ─── Start ───────────────────────────────────────────────────────────────────
// Only bind a port when run directly (`node index.js`); stays silent when
// imported by the test suite via supertest.
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) app.listen(PORT, () => {
  console.log(`\n🔭 ReachOut discovery engine running on http://localhost:${PORT}`);
  console.log(`   Endpoints:`);
  console.log(`   GET  /api/health`);
  console.log(`   GET  /api/locations  (state/country picker data)`);
  console.log(`   GET  /api/discover?field=robotics&unis=I63966007&locations=US-CA,DE&page=1&per_page=12`);
  console.log(`   GET  /api/institutions?q=stanf  (prefix autocomplete)`);
  console.log(`   GET  /api/professor/:authorId`);
  console.log(`   GET  /api/professor/:authorId/papers`);
  console.log(`   GET  /api/professor/:authorId/email`);
  console.log(`   POST /api/professor/:authorId/draft-email  (requires ANTHROPIC_API_KEY env var)`);
  console.log(`   POST /api/analyze-resume  (requires ANTHROPIC_API_KEY env var)`);
  console.log(`   POST /api/recommend  (profile-driven reply-fit, no key)`);
  console.log(`   POST /api/merge-profile  (requires ANTHROPIC_API_KEY env var)\n`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn(`   ⚠️  ANTHROPIC_API_KEY is not set — /api/analyze-resume will return 502.\n`);
  }
});

// ─── Test-only exports ─────────────────────────────────────────────────────────
// Surfaces the app + pure helpers for the node:test/supertest suite. No effect on
// the running server. `cache` is exported so route tests can clear it between cases.
export {
  app,
  cache,
  cacheGet,
  cacheSet,
  cacheDelete,
  cacheClear,
  verifyFirebaseToken,
  dayKeyUTC,
  msUntilNextUtcMidnight,
  reserveDailyUpload,
  refundDailyUpload,
  emailsFromHtml,
  raceForEmail,
  reconstructAbstract,
  computeMatchScore,
  normalizeAuthor,
  normalizeWork,
  isLatinName,
  isActiveAuthor,
  buildAuthorStats,
  baselineHigh,
  FIELD_H_BASELINE,
  computeResponsiveness,
  computeReplyFitScore,
  recommendForInterests,
  registrableDomain,
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
  resolveLocations,
  haversineKm,
  proximity01,
  PROX_CONFIG,
  resolveInstitutionGeos,
  resolveWikidataCoords,
  resolveStudentGeoByName,
  LOCATIONS_PAYLOAD,
  LOC_RE,
  LOCATION_TOKEN_SET,
  US_STATES,
  RESEARCH_COUNTRIES,
};
