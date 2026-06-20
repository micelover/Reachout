# Résumé analysis — "Your cold-email pitch" card + matches-first layout

**Date:** 2026-06-19
**Area:** Résumé-analysis workspace — `index.html` (split layout + reveal JS) and a small
addition to `server/index.js` (`/api/analyze-resume`).
**Goal:** After a résumé is analyzed, show the user a generated "pitch" of themselves —
the stuff that goes into a cold email — *next to* their matches and their own document,
without burying the professor matches they came for.

## Problem

Today, after `analyzeResume()` succeeds, `revealResults()` fills the right column with an
interests panel (interests chips + one-line summary) followed by the suggested-professor
grid, while the uploaded document stays full-size in the sticky left column. The right
column only surfaces *interests + a one-liner* — there's no consolidated "here's how to
pitch yourself in an outreach email" view (selling points, accomplishments).

The user wants that pitch, but the matches must stay front-and-center — the early mockup
that stacked a full pitch box *above* the matches pushed the professors below the fold.

## Decisions (confirmed with user, via live mockups)

1. **Layout:** two columns. **Professors take the dominant left column** (first thing seen).
   A **sticky right column** stacks the **shrunken résumé document on top** and the
   **pitch card beneath it**, both pinned as the user scrolls. (Mockup: `layout-doc.html`.)
2. **Pitch card content (all visible, no expand):**
   - Summary **blurb** (2–3 sentences, the email-ready intro).
   - **Research interests** (chips).
   - **Selling points** (≈3 bullets — what makes them a strong candidate).
   - **Accomplishments** (≈3 bullets — concrete wins: papers, GPA, awards).
3. **Copy button:** "Copy pitch for your email" copies **just the summary blurb** to the
   clipboard (cleanest thing to drop into an email body).
4. **Résumé in the right column** keeps the "Analyzed" badge and a "Change file" affordance;
   it shows the actual uploaded file (compact, glanceable preview size).
5. **Mobile (single column):** stack order is **résumé → pitch → professors**.

## Design

### Backend — `server/index.js` (`/api/analyze-resume`)

Extend the Claude extraction to return two new arrays, and pass them through.

- `RESUME_PROMPT`: add two keys to the requested JSON object:
  - `"sellingPoints"`: array of ~3 short phrases — concrete strengths that make this
    person a compelling research candidate (empty array if not a resume).
  - `"accomplishments"`: array of ~3 short phrases — concrete achievements (publications,
    GPA/honors, awards, notable projects) (empty array if not a resume).
  Update the inline example to include both keys.
- In the handler: read `extracted.sellingPoints` / `extracted.accomplishments`, default to
  `[]`, cap each to a small N (≈4) and `.filter(Boolean)` like `interests`.
- Add both to **every** response shape that currently returns results, including the
  early `!interests.length` return and the final `res.json(...)`. Update the response-doc
  comment (`{ interests, summary, transcript, sellingPoints, accomplishments, professors }`).
- No change to OpenAlex matching, caching, the `400`/`502` contract, or `pickDominantField`.

### Frontend — `index.html`

**Markup (`#resumeWorkView` / `.resume-split` / `.resume-right`):** restructure so the
post-analysis state is a grid of three regions — professors (left), and a sticky right
column containing the document card then the pitch card. The existing
`#resumeInterests` panel is **replaced** by the pitch card (interests now live inside it).

New pitch card structure (`#resumePitch`), populated by JS:
- Header: icon + "Your cold-email pitch" + "Generated from your résumé" + (Copy handled
  by the button at the card foot).
- `#resumePitchBlurb` — the summary blurb (keep the existing typewriter reveal if desired).
- Research interests — `#resumeChips` (reused).
- Selling points — `#resumePitchSelling` (bulleted, ✓ markers).
- Accomplishments — `#resumePitchAccomp` (bulleted, ✓ markers).
- "Copy pitch for your email" button → copies the blurb text via `navigator.clipboard`,
  with a brief "Copied" confirmation state.

**Layout states:** the workspace has two visual states on `.resume-split`:
- *Analyzing* (unchanged): document in the sticky left column with the scan animation,
  right side shows the existing placeholder/ghosts.
- *Analyzed* (new): professors fill the wide left column; the document **relocates** into
  the right column above the pitch. Achieve via a state class toggled in `revealResults()`
  (e.g. `.resume-split.analyzed`) that re-grids the regions, plus relocating the
  `#resumeStage` node into the right column (or grid-area reorder). Decide the exact
  mechanism in the plan; either way the document node and its "Analyzed" badge are reused,
  not duplicated.

**JS (`revealResults`, `setResumeState`, reset helpers):**
- `revealResults({ interests, summary, professors, sellingPoints, accomplishments })`:
  fill the blurb, interests chips, selling-point bullets, accomplishment bullets; render
  the professor grid into the left column; apply the `analyzed` layout state.
- Render bullets with `esc()` (these are model-generated strings — escape like interests).
- Hide/empty any section whose array is empty (e.g. no selling points → omit that block),
  so non-résumé or sparse inputs degrade quietly.
- `resetProfileSections`/state reset: clear the new bullet containers and the `analyzed`
  state on a new run or "Change file", mirroring the current interests reset.

### CSS

Reuse existing tokens and patterns (`--g800`, `.interest-chip`, sticky `.resume-left`
pattern, `--sh-md`). Add styles for the pitch card (`.sc-head`, `.blurb`, `.psec`,
`.bullets`) and the right-column stack, matching the mockup. Responsive: at the existing
`max-width:880–980px` breakpoint, collapse to one column in **résumé → pitch → professors**
order; the right column un-sticks.

## Affected code (anchors)

- Backend: `RESUME_SYSTEM`/`RESUME_PROMPT` (~591), `/api/analyze-resume` handler returns
  (~665–718).
- Markup: `#resumeWorkView`/`.resume-split` (~1263), `.resume-left` doc stage (~1265),
  `.resume-right` + `#resumeInterests` (~1293–1315).
- CSS: `.resume-split`/`.resume-left`/`.resume-right` (~536–569), interests/summary
  styles (~662–671).
- JS: `analyzeResume` (~2133), `revealResults` (~2191), `renderResumeProfGrid` (~2236),
  reset/`setResumeState` (~1764), phase/scan helpers (unchanged).

## Out of scope

- The professor *profile* detail view (separate `profile-dossier-redesign` spec).
- OpenAlex matching/scoring, caching, error contract.
- Editing the pitch in-place, regenerating it, or saving it server-side.
- The scan animation itself (reused as-is).

## Success criteria

- After analysis: professors are the dominant, immediately-visible content (left column).
- The right column shows the user's actual document **and** a full pitch — blurb,
  interests, selling points, accomplishments — all visible without expanding, pinned on
  scroll.
- "Copy pitch for your email" copies the blurb to the clipboard with a visible confirm.
- New backend fields are AI-extracted; empty arrays degrade quietly (sparse/non-résumé).
- On mobile, content stacks résumé → pitch → professors.
- Loading/error states behave as before (failures fall back to the ready state).
