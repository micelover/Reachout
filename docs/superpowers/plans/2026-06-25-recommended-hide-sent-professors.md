# Hide Sent Professors from Recommended (Live Buffer Swap) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Once a user sends an outreach email to a professor, that professor leaves the Recommended grid and the next-best match takes their place — instantly, with no page reload, and the count stays topped up.

**Architecture:** The server's `/api/recommend` learns an optional `excludeIds` list and drops those professors from the scored pool *before* it trims to the limit, so the slot refills from the next-best survivor. The frontend treats the already-fetched `cachedResults` (~150 scored professors) as a living buffer: the Recommended grid render filters out Sent/Replied professors, a send re-renders the grid quietly, and when the non-sent buffer thins below one page the client fetches more in the background.

**Tech Stack:** Node.js + Express (ES modules), `node:test` + `supertest` for the server; single-file vanilla `index.html` for the client (no build, no frontend test harness).

**Spec:** `docs/superpowers/specs/2026-06-25-recommended-hide-sent-professors-design.md`

**Mechanism note (faithful refinement of the spec):** the spec says "remove the professor from `cachedResults`." This plan instead **filters at render time** against the live Sent/Replied set (`recsSentIds()`), leaving `cachedResults` as the canonical fetched buffer. Same observable behavior (sent professors never appear; count tops up), but idempotent and robust to the async Firestore hydration race — re-rendering always reflects the current sent set without array surgery.

---

## File Structure

- **`server/index.js`** — `recommendForInterests()` (server/index.js:2435) gains an `excludeIds` option and filters the scored pool before `.slice(0, limit)` (server/index.js:2557). The `POST /api/recommend` route (server/index.js:3051) sanitizes `body.excludeIds` to author-id shape and threads it through. `/api/analyze-resume` is untouched (it never passes `excludeIds`).
- **`server/test/recommend.test.js`** — two new contract tests for `excludeIds` (exclusion + top-up, and sanitization/whole-pool exclusion).
- **`index.html`** — new helpers `recsSentIds()`, `refreshRecsGrid()`, `maybeRefillRecs()`; `renderFiltered()` (index.html:4164) filters Sent/Replied in recommend mode and triggers the background refill; `logOutreachSent()` (index.html:6667) and `hydrateOutreachForUser()` (index.html:6460) call `refreshRecsGrid()`; new refill state next to `recsSeq` (index.html:5937). Optional subtle fade CSS.

---

## Task 1: Server — `excludeIds` support (`/api/recommend`)

**Files:**
- Modify: `server/index.js` — `recommendForInterests()` signature + pool filter; `/api/recommend` route body parsing + docblock.
- Test: `server/test/recommend.test.js`

- [ ] **Step 1: Write the failing tests**

Append these two tests to the END of `server/test/recommend.test.js` (after the existing 502 test, line ~212). They reuse the file's existing `mockOpenAlexHappyPath()` helper and its two canned authors `A2000` (superstar) and `A1000` (reachable riser, which reply-fit ranks first).

```javascript

// ── excludeIds: drop already-contacted professors, then top the list back up ──

test('POST /api/recommend: excludeIds drops a professor and tops the list back up from the pool', async () => {
  mockOpenAlexHappyPath();
  // Baseline at limit:1 → the single top-ranked survivor (the reachable riser).
  const base = await request(app)
    .post('/api/recommend')
    .send({ interests: ['machine learning'], field: 'Computer Science', limit: 1 });
  assert.equal(base.status, 200);
  assert.equal(base.body.professors.length, 1, 'baseline returns exactly one professor');
  const topId = base.body.professors[0].id;

  // Excluding that professor must REFILL the slot from the pool (the other author),
  // not collapse the list to empty — this is the "stays full" guarantee.
  const res = await request(app)
    .post('/api/recommend')
    .send({ interests: ['machine learning'], field: 'Computer Science', limit: 1, excludeIds: [topId] });
  assert.equal(res.status, 200);
  assert.equal(res.body.professors.length, 1, 'count topped up from the pool, not just filtered down');
  assert.ok(!res.body.professors.some((p) => p.id === topId), 'the excluded professor is gone');
});

test('POST /api/recommend: excludeIds is sanitized and can empty the list when it covers the whole pool', async () => {
  mockOpenAlexHappyPath();
  // Garbage tokens are dropped (only /^A\d+$/ shapes survive). Excluding BOTH stub
  // authors leaves nothing → empty array, still 200 (honest, no padding, no crash).
  const res = await request(app)
    .post('/api/recommend')
    .send({
      interests: ['machine learning'],
      field: 'Computer Science',
      excludeIds: ['not-an-id', 'A123 OR 1=1', 42, null, 'A2000', 'A1000'],
    });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.professors));
  assert.equal(res.body.professors.length, 0, 'excluding the whole pool yields an empty list, not a crash');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npm test`
Expected: the two new tests FAIL — the first because `excludeIds` is ignored so the excluded professor still appears (or the count assertion differs), the second because excluded professors are not removed (length is 2, not 0). Existing tests still pass.

- [ ] **Step 3: Add `excludeIds` to `recommendForInterests` and filter the pool**

In `server/index.js`, change the function signature at `recommendForInterests` (server/index.js:2435):

```javascript
async function recommendForInterests(interests, { field = '', goal = '', unis = [], limit = 24, perPage, studentGeo = null } = {}) {
```

to:

```javascript
async function recommendForInterests(interests, { field = '', goal = '', unis = [], limit = 24, perPage, studentGeo = null, excludeIds = [] } = {}) {
```

Immediately after that line (before the `effPerPage` line), add:

```javascript
  // Author ids the caller has already contacted (Sent/Replied) — dropped from the
  // scored pool BEFORE the limit slice so the list refills from the next-best.
  const excludeSet = new Set(Array.isArray(excludeIds) ? excludeIds : []);
```

Then, in the `const professors = [...seen.values()]` chain (server/index.js:2536), insert a `.filter()` between the `.map(...)` and the `.sort(...)`. The existing code is:

```javascript
      const { stats, dominantField, ...card } = prof; // drop internals from the DTO
      return { ...card, matchScore: percent, breakdown };
    })
    // Primary by score; exact ties break toward the geographically nearer professor.
    .sort((a, b) => (b.matchScore - a.matchScore) ||
```

Change it to:

```javascript
      const { stats, dominantField, ...card } = prof; // drop internals from the DTO
      return { ...card, matchScore: percent, breakdown };
    })
    // Already-contacted professors drop out BEFORE the limit slice, so the next-best
    // survivors top the returned list back up to `limit` automatically.
    .filter((card) => !excludeSet.has(card.id))
    // Primary by score; exact ties break toward the geographically nearer professor.
    .sort((a, b) => (b.matchScore - a.matchScore) ||
```

- [ ] **Step 4: Parse + thread `excludeIds` in the route**

In the `POST /api/recommend` handler, find the call (server/index.js:3105):

```javascript
    const professors = await recommendForInterests(interests, { field, goal, unis: mergedUnis, limit, studentGeo });
```

Replace it with the parse + pass-through:

```javascript
    // Professors the client has already contacted (Sent/Replied) — excluded from the
    // scored pool so the Recommended grid can top itself back up. Author-id shape only;
    // deduped and capped, bad tokens silently dropped (same discipline as `unis`).
    const excludeIds = [...new Set(
      (Array.isArray(body.excludeIds) ? body.excludeIds : [])
        .map((s) => String(s ?? '').trim())
        .filter((s) => /^A\d+$/.test(s)),
    )].slice(0, 500);

    const professors = await recommendForInterests(interests, { field, goal, unis: mergedUnis, limit, studentGeo, excludeIds });
```

Then update the route docblock just above the handler (server/index.js:3041). Change:

```javascript
 * Body: { interests: string[], field?: string, goal?: string,
 *         unis?: string[] (OpenAlex ids), limit?: number }
```

to:

```javascript
 * Body: { interests: string[], field?: string, goal?: string,
 *         unis?: string[] (OpenAlex ids), limit?: number,
 *         excludeIds?: string[] (OpenAlex author ids to omit — already-contacted) }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && npm test`
Expected: ALL tests PASS, including the two new `excludeIds` tests and every pre-existing one.

- [ ] **Step 6: Commit**

```bash
git add server/index.js server/test/recommend.test.js
git commit -m "feat(recommend): exclude already-contacted professors via excludeIds

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Client — hide Sent/Replied from the Recommended grid

This makes sent professors disappear from the Recommended grid on the next render (covers initial load and post-hydration). Tasks 3–4 add the instant swap and background top-up.

**Files:**
- Modify: `index.html` — add `recsSentIds()`; rewrite `renderFiltered()` (index.html:4164) to filter Sent/Replied in recommend mode.

- [ ] **Step 1: Add the `recsSentIds()` helper**

In `index.html`, find the `outreachStatus()` function (index.html:6547). It ends like this:

```javascript
function outreachStatus(id) {
  if (!id) return 'toEmail';
  return displayStatus({
    replied: _outreachReplied[id] === true,
    gmailMessageId: _verifiedSentIds.has(id) ? '1' : null,
    draftedAt: _emailedIds.has(id) ? 1 : null,
  });
}
```

Immediately AFTER that closing `}`, add:

```javascript

// Author ids whose derived outreach status is Sent or Replied — i.e. everyone the
// user has actually emailed. These drop out of the scored Recommended grid (Drafted
// and To-Email stay). Built from the same in-session mirrors displayStatus() uses, so
// it agrees with the tracker. `_outreachReplied` is a plain {authorId: true|false|null}.
function recsSentIds() {
  const ids = new Set(_verifiedSentIds);                  // confirmed Gmail sends
  for (const id of Object.keys(_outreachReplied)) {
    if (_outreachReplied[id] === true) ids.add(id);       // replied implies sent
  }
  return ids;
}
```

- [ ] **Step 2: Rewrite `renderFiltered()` to filter Sent/Replied in recommend mode**

Replace the ENTIRE existing `renderFiltered()` function (index.html:4164–4218) with the version below. The changes: compute `shown` = filtered minus the Sent/Replied set (recommend mode only), use `shown` everywhere `filtered` was used after the initial fetch, and call `maybeRefillRecs(shown.length)` (defined in Task 4 — until then it is a no-op you will add in Step 3 of this task as a stub).

```javascript
function renderFiltered() {
  const grid = document.getElementById('profGrid');
  const pag  = document.getElementById('profPagination');
  const filtered = applyFilters(cachedResults);

  // Scored recommend mode: professors already emailed (Sent/Replied) drop out of the
  // grid so the next-best buffered professor takes their slot. Every other mode shows
  // the full filtered list unchanged.
  const sent = browseMode === 'recommend' ? recsSentIds() : null;
  const shown = (sent && sent.size) ? filtered.filter(p => !sent.has(p.id)) : filtered;

  // Once the non-sent buffer thins below one page, quietly fetch more (background).
  if (browseMode === 'recommend') maybeRefillRecs(shown.length);

  if (!shown.length) {
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:60px 20px">
      <div style="font-size:32px;margin-bottom:12px">🎓</div>
      <div style="font-size:15px;font-weight:600;color:var(--n800);margin-bottom:6px">No professors match your filters</div>
      <div style="font-size:13.5px;color:var(--n500)">Try clearing the University filter to see all results.</div>
    </div>`;
    pag.innerHTML = '';
    return;
  }

  const user = getAuthUser();
  const page = state.page || 1;
  const perPage = state.perPage;
  // Browse/search mode pages SERVER-SIDE: cachedResults already holds just this page
  // (a fresh /api/discover fetch), so render it whole and let renderPagination drive
  // page changes through loadBrowse. Recommend/resume hold the full result set in
  // memory and page CLIENT-side (slice + renderPaginationFor over that list).
  const serverPaged = browseMode === 'search';
  const pageResults = serverPaged ? shown : shown.slice((page - 1) * perPage, page * perPage);

  if (user || shown.length <= 3) {
    grid.innerHTML = pageResults.map(cardHTML).join('');
    hydrateLogos(grid);
    wireEmailPrewarm(grid);
    if (serverPaged) renderPagination(Math.min(state.total, perPage * BROWSE_PAGE_CAP), page);
    else renderPaginationFor(shown.length, page);
  } else {
    const visible = pageResults.slice(0, 3).map(cardHTML).join('');
    const gated   = pageResults.slice(3).map(cardHTML).join('');
    grid.innerHTML = visible + (gated ? `
      <div class="grid-gate-wrap">
        <div class="blurred-rows">${gated}</div>
        <div class="grid-gate-overlay">
          <div class="gate-card">
            <div class="gate-lock">🔒</div>
            <div class="gate-title">Sign in to view all results</div>
            <div class="gate-sub">We found <strong>${shown.length.toLocaleString()} professors</strong> matching your search. Create a free account to unlock them all.</div>
            <div class="gate-btns">
              <button class="gate-btn-primary" onclick="showAuth('sign-in')">Sign In</button>
              <button class="gate-btn-secondary" onclick="showAuth('sign-up')">Create Account — it's free</button>
            </div>
            <div class="gate-note">No credit card required</div>
          </div>
        </div>
      </div>` : '');
    hydrateLogos(grid);
    wireEmailPrewarm(grid);
    pag.innerHTML = '';
  }
}
```

- [ ] **Step 3: Add a temporary `maybeRefillRecs` stub so Task 2 stands alone**

So this task is independently testable before Task 4 lands, add a stub directly BEFORE `function renderFiltered()` (index.html:4164):

```javascript
// Background top-up of the Recommended buffer — real implementation lands in a later
// task; stub keeps renderFiltered() callable on its own.
function maybeRefillRecs(/* availableCount */) {}
```

(Task 4, Step 1 replaces this stub with the full implementation.)

- [ ] **Step 4: Manual verification**

Run: `cd server && node --watch index.js` (in one terminal), then open `index.html` via the app's normal local flow and sign in with a profile that has interests.
Expected:
- Recommended grid renders as before for a fresh account.
- In the browser console, run `recsSentIds()` → returns a `Set` (empty for a fresh account).
- Manually simulate a sent professor: in the console run `_verifiedSentIds.add('<an A-id visible on a recommended card>'); renderFiltered();` → that card disappears and the next one shifts up; the rest of the grid is intact (no skeletons, no reload).

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat(recommend): hide Sent/Replied professors from the Recommended grid

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Client — instant swap on send + re-render after hydration

**Files:**
- Modify: `index.html` — add `refreshRecsGrid()`; call it from `logOutreachSent()` (index.html:6667) and from `hydrateOutreachForUser()` (index.html:6460).

- [ ] **Step 1: Add the `refreshRecsGrid()` helper**

In `index.html`, find the `recsSentIds()` function you added in Task 2 (right after `outreachStatus()`). Immediately AFTER `recsSentIds()`'s closing `}`, add:

```javascript

// Repaint the Recommended grid IFF it is the active view. Used after a send (the
// just-sent professor drops out via recsSentIds(), the next-best buffered professor
// takes its slot) and after Firestore outreach hydration (sent professors loaded from
// the cloud disappear). No-op elsewhere — the next renderFiltered() excludes them anyway.
function refreshRecsGrid() {
  if (browseMode !== 'recommend') return;
  if (!document.getElementById('page-browse')?.classList.contains('active')) return;
  renderFiltered();
}
```

- [ ] **Step 2: Call `refreshRecsGrid()` after a confirmed send**

In `logOutreachSent()` (index.html:6667), find this block (note the `sentAt: Date.now()` line that uniquely identifies the SENT path, not the Drafted path):

```javascript
  renderTracker();
  refreshHearts();
  logOutreach(id, {
    saved: true,
    sentAt: Date.now(),
    sentVia: 'gmail',
```

Change it to insert the call after `refreshHearts();`:

```javascript
  renderTracker();
  refreshHearts();
  refreshRecsGrid();   // sent professor leaves the Recommended grid; next-best slides up
  logOutreach(id, {
    saved: true,
    sentAt: Date.now(),
    sentVia: 'gmail',
```

- [ ] **Step 3: Call `refreshRecsGrid()` after Firestore outreach hydration**

In `hydrateOutreachForUser()` (index.html:6460), find the SUCCESS path (the one immediately followed by `} catch (err) {`):

```javascript
    renderTracker();
    refreshHearts();
  } catch (err) {
    console.warn('outreach hydrate failed', err);
```

Change it to:

```javascript
    renderTracker();
    refreshHearts();
    refreshRecsGrid();   // sent professors loaded from the cloud drop out of Recommended
  } catch (err) {
    console.warn('outreach hydrate failed', err);
```

- [ ] **Step 4: Manual verification**

Run the app as in Task 2. Sign in, open Recommended, and either send a real email from a recommended professor's draft modal, OR simulate in the console:
```javascript
_draftAuthorId = '<an A-id visible on a recommended card>';
logOutreachSent({ messageId: 'test', threadId: 'test' });
```
Expected: while viewing Recommended, the sent professor's card vanishes and the next-best one slides into place immediately — no skeletons, no full reload, no scroll jump. Reload the page (still signed in) → after hydration the same professor stays absent from Recommended but is present in the Outreach Tracker.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat(recommend): swap in the next professor the moment one is emailed

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Client — background refill when the buffer runs low

**Files:**
- Modify: `index.html` — add refill state next to `recsSeq` (index.html:5937); replace the `maybeRefillRecs` stub (from Task 2) with the real implementation; reset `recsExhausted` in `loadRecommendations()` (index.html:4380).

- [ ] **Step 1: Add refill state**

In `index.html`, find (index.html:5934–5937):

```javascript
let recsDirty = true;
```

…and a few lines below it:

```javascript
let recsSeq = 0;
```

Immediately AFTER the `let recsSeq = 0;` line, add:

```javascript
// Background top-up state for the Recommended buffer. When the non-sent buffer thins
// below one page we fetch more (excluding everyone already shown + already emailed).
// `recsRefilling` prevents concurrent fetches; `recsExhausted` stops retrying once a
// refill returns nothing new (reset whenever a fresh loadRecommendations runs).
const RECS_LOW_WATER = 30;     // remaining non-sent professors before a refill fires
let recsRefilling = false;
let recsExhausted = false;
```

- [ ] **Step 2: Replace the `maybeRefillRecs` stub with the real implementation**

Find the stub added in Task 2 (directly above `function renderFiltered()`, index.html:4164):

```javascript
// Background top-up of the Recommended buffer — real implementation lands in a later
// task; stub keeps renderFiltered() callable on its own.
function maybeRefillRecs(/* availableCount */) {}
```

Replace it entirely with:

```javascript
// Background top-up: when the non-sent Recommended buffer thins below one page, fetch
// another scored batch — excluding everyone already in the buffer AND everyone emailed
// — and append the genuinely new professors. Never blocks, never shows skeletons.
// Guarded against concurrent fires (recsRefilling), stale full-reloads (recsSeq), and
// a dry pool (recsExhausted). availableCount is the count renderFiltered() can show now.
async function maybeRefillRecs(availableCount) {
  if (browseMode !== 'recommend' || recsRefilling || recsExhausted) return;
  if (availableCount >= RECS_LOW_WATER) return;

  const m = _userMemory || {};
  const interests = Array.isArray(m.interests) ? m.interests : [];
  if (!interests.length && !m.field) return;   // nothing to score against

  recsRefilling = true;
  const seq = recsSeq;   // snapshot: a fresh loadRecommendations bumps recsSeq → bail
  try {
    const exclude = [...recsSentIds(), ...cachedResults.map(p => p.id)];
    const data = await apiPost('/api/recommend', {
      interests,
      field: m.field || '',
      goal: m.goal || '',
      unis: [...browseFilter.unis.keys()],
      locations: [...browseFilter.locations.keys()],
      institution: m.institution || '',
      institutionId: m.institutionId || '',
      institutionLoc: m.institutionLoc || null,
      excludeIds: exclude,
      limit: 150,
    });
    if (seq !== recsSeq) return;                 // superseded by a newer full load

    const have = new Set(cachedResults.map(p => p.id));
    const fresh = (data.professors || []).filter(p => p && !have.has(p.id));
    if (fresh.length) {
      cachedResults = cachedResults.concat(fresh);
      if (browseMode === 'recommend') renderFiltered();   // repaint quietly with the bigger buffer
    } else {
      recsExhausted = true;   // pool is dry — stop retrying until inputs change
    }
  } catch (_) {
    // Soft-fail: leave the buffer as-is. A later render may retry.
  } finally {
    recsRefilling = false;
  }
}
```

- [ ] **Step 3: Reset `recsExhausted` on a fresh recommend load**

In `loadRecommendations()` (index.html:4330), find (index.html:4380):

```javascript
    cachedResults = data.professors || [];
    recsDirty = false;
    state.page = 1;
```

Change it to:

```javascript
    cachedResults = data.professors || [];
    recsDirty = false;
    recsExhausted = false;   // fresh pool → background refill may run again
    state.page = 1;
```

- [ ] **Step 4: Manual verification**

Run the app. Sign in with a profile that has interests so Recommended fills. In the console, lower the threshold and drain the buffer to force a refill:
```javascript
// Simulate having emailed most of the buffer so fewer than 30 non-sent remain:
cachedResults.slice(0, cachedResults.length - 5).forEach(p => _verifiedSentIds.add(p.id));
renderFiltered();   // shown.length now < 30 → triggers maybeRefillRecs in the background
```
Expected: within a moment the grid quietly grows as a background `/api/recommend` call returns new professors (watch the Network tab for the request carrying `excludeIds`), none of which are ones you marked sent or already had. No skeletons appear. If you drain everything and the pool is genuinely exhausted, the list shrinks and no further refill requests fire (`recsExhausted === true`).

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat(recommend): background-refill the buffer when it runs low

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5 (optional): Subtle fade on the swapped-in card

A small nicety so the post-send swap reads as a gentle replacement rather than an instant pop. Skip if not wanted — the feature is complete after Task 4.

**Files:**
- Modify: `index.html` — one CSS keyframe + rule; toggle a transient class in `refreshRecsGrid()`.

- [ ] **Step 1: Add the fade CSS**

In `index.html`, find the AI outreach-email draft modal CSS comment (index.html:1058, `/* ── AI outreach-email draft modal ── */`). Directly BEFORE that line, add:

```css
/* Subtle fade applied only to the Recommended grid right after a send/hydration swap
   (refreshRecsGrid toggles .recs-swap), so the replacement card eases in instead of
   popping. Normal paging/sorting re-renders do NOT get the class, so they stay instant. */
@keyframes recs-fadein { from { opacity: .35; } to { opacity: 1; } }
#profGrid.recs-swap .prof-card { animation: recs-fadein .35s ease; }
```

- [ ] **Step 2: Toggle the class in `refreshRecsGrid()`**

Replace the `refreshRecsGrid()` function (added in Task 3) with:

```javascript
function refreshRecsGrid() {
  if (browseMode !== 'recommend') return;
  if (!document.getElementById('page-browse')?.classList.contains('active')) return;
  renderFiltered();
  const grid = document.getElementById('profGrid');
  if (grid) {
    grid.classList.remove('recs-swap');
    void grid.offsetWidth;        // force reflow so the animation restarts on each swap
    grid.classList.add('recs-swap');
  }
}
```

- [ ] **Step 3: Manual verification**

Run the app, open Recommended, send (or simulate `logOutreachSent`) on a visible card. Expected: the grid's cards ease in over ~0.35s on the swap; normal page-strip clicks remain instant (no fade).

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(recommend): subtle fade on the post-send card swap

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (whole feature)

- [ ] **Server suite green:** `cd server && npm test` → all tests pass (including the two `excludeIds` tests).
- [ ] **End-to-end, signed in with a real profile:**
  - Recommended fills with scored professors.
  - Sending an email to one (real Gmail send or the draft modal) removes that professor from Recommended immediately and slides the next-best up — no reload, no skeletons.
  - The professor remains in the Outreach Tracker (only Recommended hides them).
  - Reload while signed in → after hydration the sent professor stays absent from Recommended.
  - Generic field/name browse, search, and the resume-match list still show everyone (scope = Recommended only).
  - The manual "Open in Gmail to send manually" path marks Drafted → professor STAYS in Recommended (trigger is Sent/Replied only).
- [ ] **Code review:** route the diff to the `code-reviewer` agent (security-aware: confirms `excludeIds` is sanitized like `unis`, no new XSS sink, cache/upstream behavior unchanged).
