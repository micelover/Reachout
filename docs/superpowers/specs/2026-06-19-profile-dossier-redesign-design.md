# Professor profile redesign — compact "dossier"

**Date:** 2026-06-19
**Area:** `index.html` (single-page frontend) — profile main column + its render JS
**Goal:** Make the professor detail view (research + papers) compact, recognizable, and
fast to scan, so a user can pull facts straight into a cold-outreach email draft.

## Problem

The profile main column stacks several separate bordered cards, each with heavy
(20px) padding and 20px margins:

- `.res-sum` — "Research Summary" paragraph
- `#hookSection` — dark "Outreach Hook" card (`26px` padding)
- `#researchSection` (`.rsec`) — areas (bordered rows), keywords, focus, current/earlier directions grid
- `#pubSection` (`.rsec`) — publications as full-width cards + a "more" list + outbound links

This sprawls vertically, and the research info is duplicated between
"Research Summary" and "Research". Each publication card spans ~3 lines
(title / meta / badge row), making the list tall and slow to scan.

The sidebar `.sb-card` "Related Projects" shows **hardcoded fake data**
(e.g. "Energy-Aware Routing in Sensor Networks") on every professor.

## Decisions (confirmed with user)

1. **Merge** Research Summary + Research areas/directions into one compact band.
2. **Keep** the Outreach Hook card, but slimmer (reduced padding).
3. **Hide** the fake "Related Projects" sidebar card.
4. Headline paper cards show the professor's **most-recent** work first (newest
   leads, gets the "latest" highlight) — they're for referencing recent work in
   outreach emails. This is the one backend tweak: `/api/professor/:id/papers`
   now builds `selected` from a recency-sorted pool (was citations-sorted). The
   "more" list stays citations-sorted. Everything else is presentation-only.

## Design

### 1. Research focus band (replaces `.res-sum` + `#researchSection`)
One block, one `📚/🔬` header:
- 2-line summary (`profile.summary` / `research.summary`).
- Focus areas as inline pill chips with their count badge (from `research.areas`,
  currently rendered as `.rs-area` rows).
- "Directions" (recent vs earlier, from `/papers` → `directions`) fold into the
  same chip row as a muted trailing chip (e.g. `+ vision-language, self-supervised`)
  rather than a separate bordered 2-col grid.
- Removes duplication: a single source of "what they work on".

### 2. Outreach Hook (`#hookSection` / `.hook-card`)
Unchanged content and colors; reduce `.hook-card` padding (`26px` → ~`16px`) and
tighten internal spacing so it reads as a tip, not a hero.

### 3. Recent papers (replaces `.pub-cards` / `.pub-card`)
Dense hairline-separated rows. Each row:
- **Year** in a fixed left column (tabular-nums) for chronological scanning.
- Title (1–2 lines).
- Inline meta: venue · citations · pills (`Latest` / `Most cited` / `OA`) · `PDF` link.
- The most-recent paper (`isMostRecent`) gets a subtle green-tint highlight row.
- "More publications" list (`#pubMoreWrap`) and ORCID/Scholar/OpenAlex links
  (`#pubLinks`) retained, restyled to match. `Show more` toggle behavior unchanged.

### 4. Rhythm
Fewer, lighter containers: hairline (`1px var(--n100)`) separators between blocks
instead of multiple 20px-padded bordered boxes. Target ~40% less vertical height.

### 5. Sidebar
Remove the "Related Projects" `.sb-card` (markup + any related CSS). Keep the
"Take Action" card untouched.

## Affected code (anchors)

- Markup: `index.html` profile page — `.res-sum` (~1130), `#hookSection` (~1135),
  `#researchSection` (~1154), `#pubSection` (~1177), sidebar Related Projects (~1217).
- JS: `renderResearch` (~2783), `renderDirections` (~2838), `paperCardHTML` (~2868),
  `loadProfPapers` (~2904), and profile reset/`resetProfileSections` (~2648, ~2771).
- CSS: `.sec-head` / `.res-sum` / `.hook-*` / `.rsec` / `.rs-*` / `.pub-*` (~260–348).

## Out of scope
- Backend endpoints, OpenAlex mapping, caching.
- The professor *card* on the browse grid (`.prof-card`).
- The header `.ph-card`, tabs, and the "Take Action" sidebar card.

## Success criteria
- Same data renders with no duplicated research info.
- Papers scan top-to-bottom by year; latest paper visually distinct.
- Noticeably shorter page (qualitatively ~40% less height).
- No fake placeholder content visible.
- Empty/loading/error states still behave (sections hide quietly on fetch failure).
