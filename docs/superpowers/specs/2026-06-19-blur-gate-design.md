# Blur Gate — Design Spec
_Date: 2026-06-19_

## Summary

Logged-out users can search freely and see the result count, but only the first row of professor cards (3 cards) is readable. All subsequent rows are blurred, overlaid with a gradient dark tint, and a sign-in CTA card is anchored at the bottom of the gate. Logged-in users see the full grid with no changes.

---

## Behaviour

### Logged-out state
- The search bar, field filters, and result count (`"We've found 8,563 relevant matches"`) all work normally — no change.
- The first 3 cards rendered by `cardHTML()` display without any filter.
- Cards 4 onward are rendered into a separate `.blurred-rows` container with `filter: blur(5px)` and `pointer-events: none`.
- A `.grid-gate-overlay` div is absolutely positioned over `.blurred-rows` with:
  - A gradient: `rgba(10,20,35,0)` at the top → `rgba(10,20,35,0.72)` at the bottom.
  - A white CTA card anchored to `align-items: flex-end` at 36px from the bottom.
- Pagination is hidden while logged out (no point navigating blurred pages).
- Clicking "Sign In" or "Create Account" in the CTA calls `showAuth('sign-in')` / `showAuth('sign-up')`.

### Logged-in state
- Everything renders as today — full grid, pagination, no overlay.

### Auth check
- `getAuthUser()` (already implemented, reads `localStorage.auth_user`) is the single source of truth.
- `loadBrowse()` calls `getAuthUser()` after rendering cards to decide which path to take.

---

## HTML structure (logged-out)

```html
<!-- Row 1: fully visible, rendered directly into #profGrid -->
<div id="profGrid">
  <div class="prof-card">…</div>  <!-- card 1 -->
  <div class="prof-card">…</div>  <!-- card 2 -->
  <div class="prof-card">…</div>  <!-- card 3 -->

  <!-- Gate wrapper: cards 4+ -->
  <div class="grid-gate-wrap">
    <div class="blurred-rows">
      <div class="prof-card">…</div>
      …
    </div>
    <div class="grid-gate-overlay">
      <div class="gate-card">
        <div class="gate-lock">🔒</div>
        <div class="gate-title">Sign in to view all results</div>
        <div class="gate-sub">We found <strong>N professors</strong> matching your search…</div>
        <div class="gate-btns">
          <button class="gate-btn-primary" onclick="showAuth('sign-in')">Sign In</button>
          <button class="gate-btn-secondary" onclick="showAuth('sign-up')">Create Account — it's free</button>
        </div>
        <div class="gate-note">No credit card required</div>
      </div>
    </div>
  </div>
</div>
```

**Note:** `.grid-gate-wrap` sits as a child of `#profGrid` spanning all 3 columns (`grid-column: 1 / -1`), not a sibling. This keeps the 3-column layout intact for the first row while the gate section takes full width beneath.

---

## CSS additions

```css
/* Gate wrapper — full-width row inside the grid */
.grid-gate-wrap {
  grid-column: 1 / -1;
  position: relative;
}

/* Blurred rows grid (re-establishes 3-col layout inside the wrapper) */
.blurred-rows {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 18px;
  filter: blur(5px);
  user-select: none;
  pointer-events: none;
}

/* Dark gradient overlay */
.grid-gate-overlay {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to bottom,
    rgba(10, 20, 35, 0) 0%,
    rgba(10, 20, 35, 0.55) 30%,
    rgba(10, 20, 35, 0.72) 100%
  );
  border-radius: 14px;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding-bottom: 36px;
}

/* CTA card */
.gate-card {
  background: white;
  border-radius: 16px;
  padding: 26px 32px;
  text-align: center;
  box-shadow: 0 20px 56px rgba(0, 0, 0, .32);
  max-width: 340px;
  width: 90%;
}
.gate-lock  { font-size: 26px; margin-bottom: 10px; }
.gate-title { font-size: 17px; font-weight: 700; color: var(--n900); margin-bottom: 5px; }
.gate-sub   { font-size: 13px; color: var(--n500); line-height: 1.55; margin-bottom: 20px; }
.gate-sub strong { color: var(--n900); }
.gate-btns  { display: flex; flex-direction: column; gap: 9px; }
.gate-btn-primary   { background: var(--g800); color: white; border: none; border-radius: 10px; padding: 11px; font-size: 14px; font-weight: 600; font-family: var(--font-b); cursor: pointer; }
.gate-btn-secondary { background: white; color: var(--g800); border: 1.5px solid var(--g800); border-radius: 10px; padding: 10px; font-size: 14px; font-weight: 600; font-family: var(--font-b); cursor: pointer; }
.gate-note  { font-size: 11px; color: var(--n400); margin-top: 12px; }
```

---

## JS changes

### `loadBrowse()` — after rendering cards
```js
const user = getAuthUser();
if (user || data.results.length <= 3) {
  // logged in OR too few results to gate: render all cards normally
  grid.innerHTML = data.results.map(cardHTML).join('');
  renderPagination(state.total, page);
} else {
  // logged out with >3 results: first 3 visible, rest gated
  const visible = data.results.slice(0, 3).map(cardHTML).join('');
  const gated   = data.results.slice(3).map(cardHTML).join('');
  grid.innerHTML = visible + `
    <div class="grid-gate-wrap">
      <div class="blurred-rows">${gated}</div>
      <div class="grid-gate-overlay">
        <div class="gate-card">
          <div class="gate-lock">🔒</div>
          <div class="gate-title">Sign in to view all results</div>
          <div class="gate-sub">We found <strong>${state.total.toLocaleString()} professors</strong> matching your search. Create a free account to unlock them all.</div>
          <div class="gate-btns">
            <button class="gate-btn-primary" onclick="showAuth('sign-in')">Sign In</button>
            <button class="gate-btn-secondary" onclick="showAuth('sign-up')">Create Account — it's free</button>
          </div>
          <div class="gate-note">No credit card required</div>
        </div>
      </div>
    </div>`;
  // hide pagination for logged-out users
  pag.innerHTML = '';
}
```

### Edge cases
- If the API returns 3 or fewer results, no gate is shown (nothing to blur). The full results display normally.
- If the API returns 0 results, the existing `emptyHTML()` path is unchanged.
- The gate copy uses `state.total` (the real count from the API), so "8,563 professors" is always accurate to the search.

---

## What is NOT in scope
- Building the actual sign-in / sign-up pages (`showAuth()` remains a stub).
- Profile page gating — only the browse grid is affected.
- Any server-side enforcement — this is a purely client-side presentation gate.
