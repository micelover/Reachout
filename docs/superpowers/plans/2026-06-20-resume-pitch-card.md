# Résumé Pitch Card + Matches-First Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a résumé is analyzed, show the user a generated "cold-email pitch" of themselves (blurb, interests, selling points, accomplishments) in a sticky right column beneath a shrunk copy of their résumé, while the professor matches dominate the left column — with the scanned document animating (shrink + glide) into place on reveal.

**Architecture:** Small additive backend change (`/api/analyze-resume` returns two new AI-extracted arrays) plus a frontend restructure of the résumé workspace in `index.html`: the two-column split becomes professors-left / [doc + pitch]-right, driven by a `.done` state class on `.resume-split`. The reveal uses the FLIP technique on the existing `#resumeStage` node so the doc smoothly morphs from its large pre-results position to its small final slot. No DOM node is duplicated or relocated permanently; the doc stays in the right column and the FLIP transform is purely visual.

**Tech Stack:** Vanilla HTML/CSS/JS single-page `index.html`; Node/Express + Anthropic SDK (`claude-sonnet-4-6`) in `server/index.js`. No build step, no test runner — verification is `node --check`, `curl`, and browser observation.

**Spec:** `docs/superpowers/specs/2026-06-19-resume-pitch-card-design.md`

---

## File Structure

- **`server/index.js`** — Modify `RESUME_PROMPT` (~595) to request `sellingPoints` + `accomplishments`; modify the `/api/analyze-resume` handler (~617) to read, cap, and return them in both response paths; update the response-doc comment (~613).
- **`index.html`** — Three areas, all within the résumé workspace:
  - Markup: restructure `.resume-split` (~1263) into `#resumePrimary` (left) + `#resumeAside` (right); move `#resumeResultsSection` into the left; replace `#resumeInterests` with the new `#resumePitch` card.
  - CSS: add layout states + pitch-card styles near the existing résumé CSS (~536–671); extend the reduced-motion block (~645).
  - JS: rewrite `revealResults` (~2191), add `flipReveal` + `copyPitchBlurb` helpers, update `clearResumeFile` (~1782) and the reset block in `analyzeResume` (~2141).

---

## Task 1: Backend — return `sellingPoints` and `accomplishments`

**Files:**
- Modify: `server/index.js:595` (`RESUME_PROMPT`), `server/index.js:613` (doc comment), `server/index.js:664-718` (handler)

- [ ] **Step 1: Extend the Claude prompt**

In `server/index.js`, replace the `RESUME_PROMPT` constant (currently at ~595) with this version (adds two keys + updates the example):

```js
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
  '  "sellingPoints": array of up to 3 short phrases (max ~12 words each) capturing what makes this person ' +
  'a strong research candidate — concrete skills, built systems, or strengths a professor would value. ' +
  'Empty array if not a resume.\n' +
  '  "accomplishments": array of up to 3 short phrases (max ~12 words each) listing concrete achievements — ' +
  'publications, GPA/honors, awards, scholarships, or notable projects. Empty array if not a resume.\n' +
  'Example: {"isResume":true,"transcript":"Jane Doe\\nEducation: BSc Computer Science...",' +
  '"interests":["machine learning","computer vision"],' +
  '"summary":"PhD candidate in deep learning with a focus on image recognition.",' +
  '"sellingPoints":["Built a real-time object detection pipeline in PyTorch","Strong C++/CUDA systems background"],' +
  '"accomplishments":["First-author paper at CVPR 2025","3.9 GPA, Dean\'s List"]}';
```

- [ ] **Step 2: Read + cap the new fields in the handler**

In the `/api/analyze-resume` handler, find this block (~664-667):

```js
    // Cap interests to top 3 for the matching step.
    const interests = (extracted.interests || []).slice(0, 3).filter(Boolean);
    const summary = extracted.summary || '';
    const transcript = extracted.transcript || '';
```

Add two lines after it:

```js
    const sellingPoints = (extracted.sellingPoints || []).slice(0, 4).filter(Boolean);
    const accomplishments = (extracted.accomplishments || []).slice(0, 4).filter(Boolean);
```

- [ ] **Step 3: Return the new fields in BOTH response paths**

Replace the early no-interests return (~669-671):

```js
    if (!interests.length) {
      return res.json({ interests: [], summary, transcript, professors: [] });
    }
```

with:

```js
    if (!interests.length) {
      return res.json({ interests: [], summary, transcript, sellingPoints, accomplishments, professors: [] });
    }
```

And replace the final success return (~718):

```js
    res.json({ interests, summary, transcript, professors });
```

with:

```js
    res.json({ interests, summary, transcript, sellingPoints, accomplishments, professors });
```

- [ ] **Step 4: Update the response-doc comment**

Replace the comment line at ~613:

```js
 * Response: { interests: string[], summary: string, professors: Professor[] }
```

with:

```js
 * Response: { interests: string[], summary: string, transcript: string,
 *             sellingPoints: string[], accomplishments: string[], professors: Professor[] }
```

- [ ] **Step 5: Syntax-check the server**

Run: `node --check server/index.js`
Expected: no output, exit code 0 (a syntax error would print a `SyntaxError` with a line number).

- [ ] **Step 6: Smoke-test the validation path (no API key needed)**

Start the server in one shell: `cd server && node index.js` (it will warn if `ANTHROPIC_API_KEY` is unset — that's fine for this check).
In another shell run:

```bash
curl -s -X POST http://localhost:3000/api/analyze-resume \
  -H 'Content-Type: application/json' -d '{"data":"x","mediaType":"image/png"}'
```

Expected: `{"error":"Missing or too-small `data` field (base64 string required)."}` with HTTP 400 — confirms the route still parses/runs after the edits. (Full happy-path output is verified in Task 5 via the browser with a real résumé.)

> Note: if the server already runs on a different port, use that port. Check the console banner printed on startup.

- [ ] **Step 7: Commit**

```bash
git add server/index.js
git commit -m "feat(api): return sellingPoints and accomplishments from analyze-resume"
```

---

## Task 2: Frontend markup — restructure the workspace split

**Files:**
- Modify: `index.html:1263-1345` (the `.resume-split` block)

This task only moves/relabels existing markup and adds the empty pitch-card shell. No behavior changes yet — after this task the page may look broken until CSS (Task 3) and JS (Task 4) land. That is expected.

- [ ] **Step 1: Replace the `.resume-split` block**

Find the block that starts with `<div class="resume-split">` (~1263) and ends with its matching `</div>` just before `</div>\n      </div>\n    </div>` (the workspace close, ~1345). Replace the **entire** `<div class="resume-split"> … </div>` with the following. (Key changes: left column `#resumePrimary` now holds the placeholder + the professors results; right column `#resumeAside` holds the doc stage, the analyze button, and the new `#resumePitch` card replacing `#resumeInterests`.)

```html
      <div class="resume-split">
        <!-- LEFT (primary): placeholder pre-results, professor matches after -->
        <div class="resume-primary" id="resumePrimary">
          <div class="rw-placeholder" id="resumeRightPlaceholder">
            <div class="rw-ph-icon">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
            </div>
            <div class="rw-ph-title">Your matches will appear here</div>
            <p class="rw-ph-sub">Hit <strong>Find matching professors</strong> and we'll line up the labs whose research fits your background.</p>
            <div class="rw-ph-ghosts" aria-hidden="true">
              <div class="rw-ph-ghost"></div>
              <div class="rw-ph-ghost"></div>
              <div class="rw-ph-ghost"></div>
              <div class="rw-ph-ghost"></div>
            </div>
          </div>

          <div id="resumeResultsSection" style="display:none">
            <div class="resume-results-head">
              <div class="rrh-left">
                <span>Suggested professors</span>
                <span class="rrh-sort">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5h10M11 9h7M11 13h4M3 17l3 3 3-3M6 18V4"/></svg>
                  Sorted by best fit
                </span>
              </div>
              <div class="rrh-right">
                <div class="filter-wrap">
                  <button class="filter-btn" id="resumeUniFilterBtn" onclick="toggleResumeUniDropdown(event)">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></svg>
                    University
                    <span class="filter-count" id="resumeUniFilterCount" style="display:none">0</span>
                  </button>
                  <div class="filter-dropdown" id="resumeUniDropdown" style="width:280px;max-height:320px;overflow-y:auto">
                    <div class="fd-section-label">Filter by university</div>
                    <div id="resumeUniList" style="padding:0 8px 8px"></div>
                    <div class="fd-footer"><button class="fd-clear" onclick="clearResumeUniFilter()">Clear</button></div>
                  </div>
                </div>
                <span class="rw-count"><span class="n" id="resumeMatchCount">0</span> matches</span>
              </div>
            </div>
            <div class="prof-grid" id="resumeProfGrid"></div>
          </div>
        </div>

        <!-- RIGHT (aside): the document, then the generated pitch -->
        <div class="resume-aside" id="resumeAside">
          <div id="resumeStage" class="doc-stage">
            <div class="doc-analyzed-badge">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              Analyzed
            </div>
            <button class="doc-remove" id="resumeDocRemove" onclick="clearResumeFile()" title="Choose a different file" aria-label="Remove file">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
            <div class="doc-page-wrap" id="resumeDocPage"></div>
            <div class="scan-overlay" id="resumeScanOverlay" aria-hidden="true">
              <div class="scan-scrim"></div>
              <div class="scan-grid"></div>
              <div class="scan-beam"></div>
              <div class="read-layer" id="resumeReadLayer"></div>
            </div>
            <div class="scan-phase" id="resumePhase"></div>
          </div>

          <div id="resumeError" class="resume-error" style="display:none"></div>

          <button class="analyze-btn" id="resumeAnalyzeBtn" onclick="analyzeResume()" disabled>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            Find matching professors
          </button>

          <div class="pitch-card" id="resumePitch" style="display:none">
            <div class="pitch-head">
              <div class="pitch-ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg></div>
              <div><h3>Your cold-email pitch</h3><p>Generated from your résumé</p></div>
            </div>
            <div class="pitch-body">
              <div class="resume-summary pitch-blurb" id="resumeSummaryText"></div>

              <div class="pitch-sec" id="resumePitchInterestsSec">
                <div class="pitch-label"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V18h6v-1.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z"/><path d="M9 18h6M10 22h4"/></svg>Research interests</div>
                <div class="interests-chips" id="resumeChips"></div>
              </div>

              <div class="pitch-sec" id="resumePitchSellingSec">
                <div class="pitch-label"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>Selling points</div>
                <ul class="pitch-bullets" id="resumePitchSelling"></ul>
              </div>

              <div class="pitch-sec" id="resumePitchAccompSec">
                <div class="pitch-label"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6m12 5h1.5a2.5 2.5 0 0 0 0-5H18M6 9v6a6 6 0 0 0 12 0V9M6 4h12M8 21h8M12 17v4"/></svg>Accomplishments</div>
                <ul class="pitch-bullets" id="resumePitchAccomp"></ul>
              </div>

              <button class="pitch-copy" id="resumePitchCopy" onclick="copyPitchBlurb(this)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                <span class="pitch-copy-label">Copy pitch for your email</span>
              </button>
            </div>
          </div>
        </div>
      </div>
```

- [ ] **Step 2: Verify no leftover/duplicate IDs**

Run:

```bash
grep -n 'id="resumeInterests"\|class="resume-left"\|class="resume-right"' index.html
```

Expected: **no matches** (the old `#resumeInterests` wrapper and the `.resume-left` / `.resume-right` containers are gone — replaced by `#resumeAside` / `#resumePrimary`). If any match remains, you replaced the wrong block — re-check Step 1.

Then run:

```bash
for id in resumeStage resumeDocPage resumeChips resumeSummaryText resumeResultsSection resumeProfGrid resumePitch; do echo -n "$id: "; grep -c "id=\"$id\"" index.html; done
```

Expected: each prints `1`.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "refactor(resume): restructure workspace split into primary + aside columns"
```

---

## Task 3: Frontend CSS — layout states, pitch card, transition, reduced motion

**Files:**
- Modify: `index.html` — replace the `.resume-split` / `.resume-left` / `.resume-right` rules (~536-543); add pitch-card + state CSS after the résumé summary rule (~671); extend the reduced-motion block (~645-649).

- [ ] **Step 1: Replace the old split layout rules**

Find these lines (~536-543):

```css
.resume-split{display:grid;grid-template-columns:380px 1fr;gap:32px;align-items:start;animation:fadeUp .45s ease}
.resume-left{position:sticky;top:80px;display:flex;flex-direction:column;gap:16px}
.resume-left .analyze-btn{margin-top:0}
.resume-right{min-height:420px}
.resume-right .prof-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin-bottom:0}
.resume-right .interests-wrap{margin:0 0 30px}
.resume-right .resume-results-head{margin:0 0 18px}
```

Replace them with (note: selectors that were `.resume-right .prof-card` etc. below line 543 must also be retargeted — see Step 2):

```css
/* Pre-results: single centered column, the document is the focal element. */
.resume-split{display:grid;grid-template-columns:minmax(0,460px);justify-content:center;gap:26px;align-items:start;animation:fadeUp .45s ease}
.resume-split:not(.done) .resume-primary{display:none}
.resume-aside{display:flex;flex-direction:column;gap:16px}
.resume-aside .analyze-btn{margin-top:0}

/* Results state: professors take the wide left column, doc + pitch sticky on the right. */
.resume-split.done{grid-template-columns:1fr 360px;justify-content:stretch}
.resume-split.done .resume-aside{position:sticky;top:80px}
.resume-primary{min-height:420px}
.resume-primary .prof-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin-bottom:0}
.resume-primary .resume-results-head{margin:0 0 18px}

/* The pitch card is hidden until results land. */
.resume-split:not(.done) #resumePitch{display:none}
```

- [ ] **Step 2: Retarget the `.resume-right` prof-card overrides**

Below the replaced block, the file has a run of rules scoped to `.resume-right .prof-card`, `.resume-right .pc-head`, etc. (~545-556) and a media query (~543). Update every `.resume-right` selector in that run to `.resume-primary`, and the media query.

Find (~543):

```css
@media (max-width:1180px){.resume-right .prof-grid{grid-template-columns:1fr}}
```
Replace with:
```css
@media (max-width:1180px){.resume-primary .prof-grid{grid-template-columns:1fr}}
```

Then replace each of these (~545-556) — change the `.resume-right` prefix to `.resume-primary` (content otherwise identical):

```css
.resume-right .prof-card{padding:22px;border-radius:16px;display:flex;flex-direction:column}
.resume-right .pc-head{flex-wrap:wrap;align-items:center;gap:12px;margin-bottom:14px}
.resume-right .pc-av-init{width:46px;height:46px;font-size:14px}
.resume-right .pc-info{order:3;flex-basis:100%;padding-right:0;min-width:0}
.resume-right .pc-name{font-size:16.5px;line-height:1.2;margin-bottom:4px}
.resume-right .pc-uni{font-size:12.5px;margin-top:0}
.resume-right .match-badge{position:static;order:2;margin-left:auto;flex-shrink:0;background:var(--g50);border-color:var(--g100);color:var(--g700);font-size:12px;padding:5px 11px}
.resume-right .heart{display:none}
.resume-right .pc-desc{font-size:13px;line-height:1.6;margin-bottom:14px}
.resume-right .tag-row{margin-bottom:14px}
.resume-right .pc-foot{margin-top:auto;padding-top:14px;border-top:1px solid var(--n100)}
```

becomes (prefix swapped to `.resume-primary`):

```css
.resume-primary .prof-card{padding:22px;border-radius:16px;display:flex;flex-direction:column}
.resume-primary .pc-head{flex-wrap:wrap;align-items:center;gap:12px;margin-bottom:14px}
.resume-primary .pc-av-init{width:46px;height:46px;font-size:14px}
.resume-primary .pc-info{order:3;flex-basis:100%;padding-right:0;min-width:0}
.resume-primary .pc-name{font-size:16.5px;line-height:1.2;margin-bottom:4px}
.resume-primary .pc-uni{font-size:12.5px;margin-top:0}
.resume-primary .match-badge{position:static;order:2;margin-left:auto;flex-shrink:0;background:var(--g50);border-color:var(--g100);color:var(--g700);font-size:12px;padding:5px 11px}
.resume-primary .heart{display:none}
.resume-primary .pc-desc{font-size:13px;line-height:1.6;margin-bottom:14px}
.resume-primary .tag-row{margin-bottom:14px}
.resume-primary .pc-foot{margin-top:auto;padding-top:14px;border-top:1px solid var(--n100)}
```

Then verify no stragglers:

```bash
grep -c 'resume-right' index.html
```
Expected: `0`.

- [ ] **Step 3: Update the mobile stacking rule**

Find the existing résumé responsive rule (~569):

```css
@media (max-width:880px){.resume-split{grid-template-columns:1fr}.resume-left{position:static}.rw-placeholder{min-height:280px}}
```

Replace with (single column; order résumé+pitch first via source order — the aside is already after primary in DOM, so we reorder with `order`; mobile stack = résumé → pitch → professors):

```css
@media (max-width:880px){
  .resume-split,.resume-split.done{grid-template-columns:1fr;justify-content:stretch}
  .resume-split.done .resume-aside{position:static}
  .resume-split.done .resume-aside{order:1}
  .resume-split.done .resume-primary{order:2}
  .rw-placeholder{min-height:280px}
}
```

- [ ] **Step 4: Add the pitch-card styles**

After the `.resume-summary` rule (~671: `.resume-summary{font-size:14.5px;color:var(--n700);line-height:1.62;margin:10px 0 0}`), add:

```css
/* ── Cold-email pitch card (right column, under the document) ── */
.pitch-card{background:var(--white);border:1px solid var(--n200);border-radius:var(--r-xl);box-shadow:var(--sh-md);overflow:hidden}
.pitch-head{display:flex;align-items:center;gap:11px;padding:15px 18px;background:linear-gradient(180deg,var(--g50),#fff);border-bottom:1px solid var(--n100)}
.pitch-ic{width:33px;height:33px;border-radius:9px;background:var(--g800);color:var(--white);display:flex;align-items:center;justify-content:center;flex:none}
.pitch-head h3{font-family:var(--font-d);font-size:16.5px;font-weight:700;color:var(--n900);line-height:1.1}
.pitch-head p{font-size:11.5px;color:var(--n500);margin-top:2px}
.pitch-body{padding:15px 18px 18px}
.pitch-blurb{background:var(--n50);border:1px solid var(--n200);border-left:3px solid var(--g600);border-radius:9px;padding:11px 13px;font-size:13px;color:var(--n700);line-height:1.55;margin:0}
.pitch-sec{margin-top:15px}
.pitch-label{display:flex;align-items:center;gap:7px;font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--n400);margin-bottom:10px}
.pitch-label svg{width:13px;height:13px;color:var(--g600);flex:none}
.pitch-bullets{list-style:none;display:flex;flex-direction:column;gap:8px}
.pitch-bullets li{display:flex;gap:8px;font-size:12.5px;color:var(--n700);line-height:1.45}
.pitch-bullets li svg{width:14px;height:14px;color:var(--g600);flex:none;margin-top:2px}
.pitch-bullets li b{color:var(--n900);font-weight:600}
.pitch-copy{width:100%;justify-content:center;margin-top:16px;display:inline-flex;align-items:center;gap:7px;background:var(--g800);color:var(--white);font-size:12.5px;font-weight:600;padding:10px 14px;border-radius:var(--r-md);border:none;font-family:var(--font-b);cursor:pointer;transition:background .15s}
.pitch-copy:hover{background:var(--g700)}
.pitch-copy.copied{background:var(--g600)}

/* Reveal: matches cascade in, pitch slides up once .done is set. */
.resume-split.done #resumeResultsSection{animation:fadeUp .5s ease both;animation-delay:.35s}
.resume-split.done #resumePitch{animation:fadeUp .5s ease both;animation-delay:.5s}
```

- [ ] **Step 5: Extend the reduced-motion block**

Find the reduced-motion block (~645-649) and add the two new reveal animations to the "no animation" list. Replace:

```css
@media (prefers-reduced-motion:reduce){
  .read-caret,.read-hl,.read-tag,.scan-phase::before{animation:none}
  #resumeChips .interest-chip,#resumeProfGrid.cascade > *{animation:none}
  .scan-beam,.rw-eyebrow .rw-pulse,.rw-ph-icon{animation:none}
}
```

with:

```css
@media (prefers-reduced-motion:reduce){
  .read-caret,.read-hl,.read-tag,.scan-phase::before{animation:none}
  #resumeChips .interest-chip,#resumeProfGrid.cascade > *{animation:none}
  .scan-beam,.rw-eyebrow .rw-pulse,.rw-ph-icon{animation:none}
  .resume-split.done #resumeResultsSection,.resume-split.done #resumePitch{animation:none}
}
```

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "style(resume): pitch card, matches-first layout states, reduced-motion"
```

---

## Task 4: Frontend JS — populate pitch, FLIP reveal, copy, resets

**Files:**
- Modify: `index.html` — `revealResults` (~2191); add `flipReveal` + `copyPitchBlurb` near it; `clearResumeFile` (~1782); the reset block at the top of `analyzeResume` (~2141).

- [ ] **Step 1: Replace `revealResults`**

Find the whole `function revealResults({ interests, summary, professors }) { … }` (~2191-2230) and replace it with:

```js
// Staged reveal once the real data lands.
function revealResults({ interests, summary, professors, sellingPoints, accomplishments }) {
  const chipsEl   = document.getElementById('resumeChips');
  const summaryEl = document.getElementById('resumeSummaryText');
  const sellEl    = document.getElementById('resumePitchSelling');
  const accEl     = document.getElementById('resumePitchAccomp');
  const pitchEl   = document.getElementById('resumePitch');
  const resSection = document.getElementById('resumeResultsSection');
  const stage     = document.getElementById('resumeStage');
  const split     = document.querySelector('.resume-split');

  // Mark the document as analyzed (shows the badge).
  stage.classList.remove('scanning', 'scan-done');
  stage.classList.add('analyzed');
  document.getElementById('resumeReadLayer').innerHTML = '';

  // Swap the blank placeholder for the matches; update the heading.
  document.getElementById('resumeRightPlaceholder').style.display = 'none';
  document.getElementById('resumeWorkTitle').textContent = 'Your matches';
  document.getElementById('resumeWorkSub').textContent =
    'Your résumé and pitch are on the right — the labs that fit are on the left.';

  // ── Build the pitch card ──────────────────────────────────────────────
  // Interests as chips (reused styling).
  const ints = interests || [];
  chipsEl.innerHTML = ints.map((i, idx) =>
    `<span class="interest-chip" style="animation-delay:${idx * 90}ms">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20,6 9,17 4,12"/></svg>
      ${esc(i)}
    </span>`
  ).join('');
  document.getElementById('resumePitchInterestsSec').style.display = ints.length ? '' : 'none';

  // Selling points + accomplishments as ✓ bullets.
  const bulletHTML = (items) => (items || []).map(t =>
    `<li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span>${esc(t)}</span></li>`
  ).join('');
  sellEl.innerHTML = bulletHTML(sellingPoints);
  accEl.innerHTML  = bulletHTML(accomplishments);
  document.getElementById('resumePitchSellingSec').style.display = (sellingPoints && sellingPoints.length) ? '' : 'none';
  document.getElementById('resumePitchAccompSec').style.display  = (accomplishments && accomplishments.length) ? '' : 'none';

  // Reset the copy button label (in case of a re-run).
  resetCopyButton();

  // Show the pitch and type out the blurb.
  pitchEl.style.display = 'block';
  setTimeout(() => typewriter(summaryEl, summary || ''), 300);

  // ── Professors into the left column ───────────────────────────────────
  resumeProfessors = professors || [];
  resumeFilter.unis.clear();
  document.getElementById('resumeUniFilterCount').style.display = 'none';
  document.getElementById('resumeUniFilterBtn').classList.remove('has-active');
  renderResumeProfGrid();
  resSection.style.display = 'block';

  // ── FLIP: morph the document from its big pre-results spot into the
  //    small right-column slot as the layout switches to two columns. ────
  flipReveal(split, stage);
}

// FLIP the #resumeStage from its current (large) rect to its post-layout
// (small) rect: switch layout, then animate the inverse transform to identity.
function flipReveal(split, stage) {
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion:reduce)').matches;
  const first = stage.getBoundingClientRect();
  split.classList.add('done');                 // layout becomes two-column; stage shrinks
  if (reduce) return;                          // reduced motion: jump to final, no animation
  const last = stage.getBoundingClientRect();
  const dx = first.left - last.left;
  const dy = first.top  - last.top;
  const sx = last.width ? first.width / last.width : 1;
  stage.style.transformOrigin = 'top left';
  stage.style.transition = 'none';
  stage.style.transform = `translate(${dx}px, ${dy}px) scale(${sx})`;
  // Two rAFs so the browser commits the inverted start before transitioning.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    stage.style.transition = 'transform .8s cubic-bezier(.7,0,.2,1)';
    stage.style.transform = 'none';
  }));
  const cleanup = () => {
    stage.style.transition = '';
    stage.style.transform = '';
    stage.style.transformOrigin = '';
    stage.removeEventListener('transitionend', cleanup);
  };
  stage.addEventListener('transitionend', cleanup);
}

// Copy ONLY the summary blurb to the clipboard (the email-ready intro).
function copyPitchBlurb(btn) {
  const text = (document.getElementById('resumeSummaryText').textContent || '').trim();
  if (!text) return;
  const done = () => {
    btn.classList.add('copied');
    btn.querySelector('.pitch-copy-label').textContent = 'Copied to clipboard';
    clearTimeout(btn._copyTimer);
    btn._copyTimer = setTimeout(resetCopyButton, 1800);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch (e) {}
  document.body.removeChild(ta);
}

function resetCopyButton() {
  const btn = document.getElementById('resumePitchCopy');
  if (!btn) return;
  btn.classList.remove('copied');
  const label = btn.querySelector('.pitch-copy-label');
  if (label) label.textContent = 'Copy pitch for your email';
}
```

- [ ] **Step 2: Reset the new state in `clearResumeFile`**

In `clearResumeFile` (~1782), find these lines (~1796-1798):

```js
  document.getElementById('resumeInterests').style.display = 'none';
  document.getElementById('resumeResultsSection').style.display = 'none';
  document.getElementById('resumeRightPlaceholder').style.display = 'flex'; // blank-right again
```

Replace with:

```js
  const split = document.querySelector('.resume-split');
  if (split) split.classList.remove('done');
  const pitch = document.getElementById('resumePitch');
  if (pitch) pitch.style.display = 'none';
  document.getElementById('resumePitchSelling').innerHTML = '';
  document.getElementById('resumePitchAccomp').innerHTML = '';
  document.getElementById('resumeChips').innerHTML = '';
  document.getElementById('resumeSummaryText').textContent = '';
  resetCopyButton();
  // Clear any in-progress FLIP transform on the doc.
  const stage = document.getElementById('resumeStage');
  stage.style.transition = ''; stage.style.transform = ''; stage.style.transformOrigin = '';
  document.getElementById('resumeResultsSection').style.display = 'none';
  document.getElementById('resumeRightPlaceholder').style.display = 'flex'; // blank-left again
```

- [ ] **Step 3: Reset the new state at the start of `analyzeResume`**

In `analyzeResume` (~2133), find the "Reset prior results" block (~2138-2144):

```js
  const intWrap   = document.getElementById('resumeInterests');
  const resSection = document.getElementById('resumeResultsSection');

  // Reset prior results
  errEl.style.display = 'none';
  intWrap.style.display = 'none';
  resSection.style.display = 'none';
  btnEl.disabled = true;
```

Replace with:

```js
  const resSection = document.getElementById('resumeResultsSection');
  const split = document.querySelector('.resume-split');

  // Reset prior results (re-run goes back to the pre-results, single-column state)
  errEl.style.display = 'none';
  if (split) split.classList.remove('done');
  document.getElementById('resumePitch').style.display = 'none';
  resSection.style.display = 'none';
  document.getElementById('resumeRightPlaceholder').style.display = 'flex';
  resetCopyButton();
  btnEl.disabled = true;
```

- [ ] **Step 4: Confirm `revealResults` is still called with the raw response**

Check that the call site in `analyzeResume` (~2178) is `revealResults(resp);` — it passes the whole response object, so the new `sellingPoints`/`accomplishments` keys flow through automatically. No change needed; just verify:

```bash
grep -n 'revealResults(resp)' index.html
```
Expected: one match.

- [ ] **Step 5: Sanity-check there are no references to removed IDs**

```bash
grep -n 'resumeInterests' index.html
```
Expected: **no matches** (all references removed). If any remain, fix them — they will throw `null` errors at runtime.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat(resume): pitch card population, FLIP reveal transition, copy-blurb"
```

---

## Task 5: End-to-end manual verification

**Files:** none (verification only).

This requires `ANTHROPIC_API_KEY` set and a real résumé image/PDF. The server reads the key from `server/.env` (see `server/.env.example`).

- [ ] **Step 1: Start the server**

```bash
cd server && node index.js
```
Expected: startup banner listing routes incl. `POST /api/analyze-resume`, no key warning if `.env` is set.

- [ ] **Step 2: Open the résumé flow**

Open `index.html` in a browser (or via however the site is normally served), navigate to the résumé upload page, and upload a real résumé (PNG/JPG/PDF).
Expected (pre-results): the document appears **centered in a single column** with the "Find matching professors" button beneath it; no professors, no pitch card yet.

- [ ] **Step 3: Analyze and watch the transition**

Click **Find matching professors**.
Expected, in order:
1. Scan beam runs over the centered document (existing animation).
2. On reveal, the **same document shrinks and glides** to a slot at the top of the right column (~0.8s, smooth — no flash/jump/reflow snap).
3. The **professor cards cascade in** on the left (wide column).
4. The **pitch card slides up** under the document on the right, showing: the typed summary blurb, **Research interests** chips, **Selling points** bullets, **Accomplishments** bullets, and the **Copy pitch for your email** button.
5. The workspace title reads **"Your matches"**.

- [ ] **Step 4: Verify the copy button**

Click **Copy pitch for your email**.
Expected: button turns and reads **"Copied to clipboard"** for ~1.8s, then reverts. Paste into a text field — clipboard contains **only the summary blurb sentence(s)**, not the bullets or interests.

- [ ] **Step 5: Verify "Change file" reset**

Click the **×** (remove) on the document.
Expected: returns to the empty dropzone; re-uploading and re-analyzing works and shows fresh results (no stale pitch/professors, doc re-centers pre-results).

- [ ] **Step 6: Verify the new backend fields are present**

In the browser devtools Network tab, inspect the `analyze-resume` response JSON.
Expected: it includes non-empty `sellingPoints` and `accomplishments` arrays (for a normal résumé), alongside `interests`, `summary`, `transcript`, `professors`.

- [ ] **Step 7: Verify mobile + reduced motion**

- Narrow the window below 880px: the layout stacks **résumé → pitch → professors** (document/pitch above the matches).
- In OS settings enable "reduce motion" (or emulate via devtools rendering → `prefers-reduced-motion: reduce`), then re-run an analysis: the document should appear in its final small slot with **no fly/shrink animation**, and matches/pitch appear without cascade — but all content is present and correct.

- [ ] **Step 8: Final confirmation**

Confirm all Task 5 checks pass. No commit needed (verification only). If any check fails, fix in the relevant earlier task's file and re-verify.

---

## Notes for the implementer

- **Why FLIP, not CSS transitions on layout:** grid-template-columns and column-swaps can't be smoothly transitioned, and the document changes both size and position. FLIP measures the real before/after rectangles so the morph is exact at any viewport width — no hardcoded offsets.
- **The document image** is the user's actual uploaded file (injected into `#resumeDocPage` by the existing `onResumeFileChange` code) — the plan does not touch that; it only repositions/animates the `#resumeStage` container.
- **No test runner exists** in this repo; that's why verification is `node --check` + curl + browser. Do not add a test framework as part of this feature.
- **Graceful degradation:** empty `sellingPoints`/`accomplishments`/`interests` arrays hide their sections (Task 4 Step 1), so a sparse or borderline résumé still renders cleanly.
