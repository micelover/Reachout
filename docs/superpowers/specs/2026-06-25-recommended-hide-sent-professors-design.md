# Hide sent professors from Recommended (live buffer swap)

**Date:** 2026-06-25
**Status:** Approved design — ready for implementation plan
**Scope:** `server/index.js` (`/api/recommend`, `recommendForInterests`), `index.html` (Recommended grid), `server/test/recommend.test.js`

## Problem

Once a user sends an outreach email to a professor, that professor should
disappear from the **Recommended Professors** grid, and the next-best match
should take their place. Today, sent professors keep appearing in the
recommendation list even after the user has already contacted them.

## Requirements (as confirmed)

1. **Trigger:** a professor leaves the Recommended grid once their derived
   outreach status is **Sent** or **Replied**. *Drafted* professors stay —
   including the "Open in Gmail to send manually" path, which marks **Drafted**
   (`sentVia:'intent'`), not Sent.
2. **Timing:** the swap happens **right after the send, quietly** — the sent
   card is replaced by the next-best professor with no skeletons, no full-grid
   reload, and no page freeze.
3. **Replacement:** one professor sent → one replacement slotted in. The count
   stays full. Replacements come from the already-fetched buffer first.
4. **Scope:** the **Recommended grid only** (`browseMode === 'recommend'`,
   `/api/recommend`). The resume-match list, generic field/name browse, and
   search are untouched. The Outreach Tracker still shows everyone.
5. **Refill:** rely on the in-memory buffer for instant swaps. Only when the
   buffer runs low does the client quietly fetch more from the server in the
   background. Never blocks the page.

## Key existing facts this design leans on

- `loadRecommendations()` (index.html:4330) fetches up to **150** scored
  professors via `POST /api/recommend` and stores them in `cachedResults`, then
  paginates **30 per page** client-side. There is already a large pre-fetched
  buffer in memory.
- Outreach status is **derived** by `displayStatus()` (index.html:6481):
  `replied → sent (gmailMessageId | sentVia==='gmail') → drafted (draftedAt |
  sentVia==='intent') → toEmail`.
- In-session mirrors hydrated from Firestore on sign-in: `_verifiedSentIds`
  (Gmail sends), `_emailedIds` (drafts/intents), `_outreachReplied` (reply
  toggle). The set to exclude is therefore
  `_verifiedSentIds ∪ { id : _outreachReplied[id] === true }`.
- `logOutreachSent({ messageId, threadId })` (index.html:6612) is the single
  place a professor becomes **Sent** (`sentVia:'gmail'`, adds to
  `_verifiedSentIds`).
- Server `recommendForInterests()` (server/index.js:2435) fans out per-bucket,
  dedupes into a `seen` map (typically **larger** than `limit`), scores, sorts,
  then `.slice(0, limit)` (server/index.js:2557) with **no padding**.

## Design

### 1. Server — `/api/recommend` + `recommendForInterests`

- `POST /api/recommend` accepts a new optional body field `excludeIds: string[]`.
  Sanitize like the existing `unis` field: keep only OpenAlex author IDs
  (`/^A\d+$/`), dedupe, cap at ~500. Unknown/garbage tokens silently dropped.
- Thread `excludeIds` into `recommendForInterests(...)`.
- In `recommendForInterests`, filter excluded IDs out of the scored array
  **immediately before** `.slice(0, limit)`. Because the deduped pool is
  over-fetched relative to `limit`, the excluded slots refill from the next-best
  survivors automatically — the returned list stays full until the pool itself
  is exhausted (then it honestly returns fewer; existing "do NOT pad" behavior).
- `/api/analyze-resume` shares `recommendForInterests` but will **not** pass
  `excludeIds`, so the resume-match list is unaffected (scope respected).

### 2. Client — instant swap on send

In `logOutreachSent()` (after the professor is marked Sent):

- If the professor's ID is present in `cachedResults`, remove it.
- If the Recommended grid is currently visible (`browseMode === 'recommend'`
  and the browse page is active), re-render the current page **quietly** — no
  skeleton cards, no scroll reset — so the gap fills from the buffer with a
  subtle fade on the incoming card. If the send happened off-grid (e.g. from the
  profile page), just update `cachedResults` silently; it will be correct on
  return.
- Net effect: 1 sent → 1 replacement, in real time, no server call.

### 3. Client — background refill when buffer runs low

- Maintain a count of non-sent professors remaining in `cachedResults`.
- **Low-water mark = 30** (one page). When the available count drops below it,
  fire a single background `POST /api/recommend` with:
  - `excludeIds` = (sent ∪ replied) **∪** every ID already in `cachedResults`
    (so the batch is genuinely new people), and
  - the usual profile/filter params.
- Append the new, deduped results to `cachedResults`. Guard with a
  `recsRefilling` flag + the existing `recsSeq` sequence so it never
  double-fires or races a profile-edit refetch. No skeletons, never blocks.

### 4. Hydration race (sign-in)

At the end of `hydrateOutreachForUser()`:

- Prune any sent/replied professors already sitting in `cachedResults` (cheap,
  in-memory) and re-render quietly if the grid is currently shown.
- If pruning leaves the buffer below the low-water mark, the step-3 refill
  handles replenishment. **No forced heavy refetch** — initial navigation loads
  are still allowed to use skeletons as today; only post-send behavior must be
  freeze-free.

### 5. Defaults (tunable)

- **Low-water mark:** 30 (one page) remaining non-sent before a background refill.
- **Swap animation:** subtle fade on the replacement card (vs. instant pop).

## Edge cases

- **Manual-Gmail path** stays Drafted → not excluded.
- **Pool/refill exhaustion:** if even a refill cannot supply enough new matches,
  the grid honestly shrinks rather than padding with junk.
- **Tracker** continues to show sent/replied professors; only the Recommended
  grid hides them.
- **Pagination** recalculates from `cachedResults.length`; removing an item
  shifts the rest up naturally.

## Testing

- Extend `server/test/recommend.test.js`: assert that passing `excludeIds`
  removes those professors from the response **and** the result still fills up to
  `limit` from the candidate pool (i.e. the count is topped up, not just
  filtered).
- Client behavior is verified manually (the frontend is the existing
  single-file, no-test-harness `index.html`).

## Out of scope

- Server-side persistence of "hidden" state beyond the existing
  `users/{uid}/outreach/{authorId}` outreach docs (the sent set already drives
  exclusion client-side).
- Hiding sent professors anywhere other than the Recommended grid.
- Changing what the manual-Gmail ("Open in Gmail to send manually") button marks.
