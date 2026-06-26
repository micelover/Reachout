# Gmail send + reply tracking — design

Date: 2026-06-25
Branch: feat/location-filter
Scope: `index.html` only (frontend SPA). No server/Firestore-rules changes.

## Goal

Make the outreach email feature fully functional end-to-end:

1. Sending an email to a professor goes out **silently via the Gmail API** (one
   click, Gmail-only) and clearly confirms **"Email sent to {Professor}"**.
2. The professor immediately shows as **Sent** in the outreach tracker.
3. Every **Sent** row gets an explicit **"Replied yet? Yes / No"** control.
   **Yes** moves the row to **Replied**; **No** keeps it **Sent** and records
   "asked, no reply yet" so it can be flipped later.

## Current state (what exists)

- `gmailSendApi({to,subject,body})` — complete Gmail REST `messages/send` via GIS
  `gmail.send` scope, returns `{id, threadId}`. Header-injection guarded in
  `buildGmailRaw`.
- `sendViaGmail()` — primary "Send email" button handler. **Only** API-sends when
  `_profEmail` is truthy; otherwise calls `openMailtoFallback()` (a `mailto:` link).
- `loadProfEmail()` — sets `_profEmail` **only** for verified/likely *real* hits.
  For institution best-guess (`source==='institution-pattern'`) it shows the
  address greyed and leaves `_profEmail = null` (display-only, never a send target).
- `logOutreachSent({messageId,threadId})` — marks the prof **Sent** (downgrade-proof),
  records `gmailMessageId`/`gmailThreadId`/`sentAt`, persists to
  `users/{uid}/outreach/{authorId}`, repaints tracker + profile stepper.
- `logOutreachFromDraft()` — marks the prof **Drafted** (`draftedAt`, `sentVia:'intent'`).
  This is what the mailto fallback calls — hence "go to Gmail" never logs as Sent.
- Tracker: `trackerRowHTML` renders a single **"Mark replied"** link on Sent rows →
  `setStatus(id,'replied')` (only handles the `'replied'` transition today).
- `displayStatus(d)`: `replied===true → replied`; `gmailMessageId|sentVia==='gmail' → sent`;
  `draftedAt|sentVia==='intent' → drafted`; else `toEmail`. (`replied===false` falls
  through to `sent` — no downgrade.)

## Root cause of "it brings me to Gmail"

When the looked-up email is an institution best-guess (very common), `_profEmail`
stays `null`, so `sendViaGmail()` takes the `mailto` fallback instead of the API
send — and that fallback logs **Drafted**, not **Sent**.

## Design

All changes are in `index.html`.

### A. Send path — Gmail API, Gmail-only

1. **Editable "To" field** at the top of the draft-modal body, above Subject.
   - Prefilled with the best address available, in priority order:
     verified → likely (real) → institution best-guess.
   - Best-guess prefill is visually flagged ("Best guess — confirm before sending").
   - A new module variable `_sendTo` is **not** the source of truth at send time;
     the field's live value is. `loadProfEmail()` records a `_bestEmail`
     `{address, confidence, isGuess}` used to prefill the field when the draft opens.
2. **`sendViaGmail()` always API-sends** to the To-field value:
   - Read + clean recipient from the To field (reuse `buildGmailRaw`'s CR/LF strip)
     and validate with a simple `/^[^@\s]+@[^@\s]+\.[^@\s]+$/` check.
   - Empty/invalid → inline error, do not send.
   - Remove the `!_profEmail → mailto` branch entirely.
   - Keep the `!gmailIsConfigured()` guard (shouldn't trigger — client ID is set).
3. **Remove the generic "Open in email instead" mailto link.** Replace with an
   **error-only** escape hatch: on consent-denied / API error, show the existing
   inline `#draftSendError` message plus a single **"Open in Gmail"** link that opens
   a *prefilled Gmail compose URL*
   (`https://mail.google.com/mail/?view=cm&fs=1&to=…&su=…&body=…`) — still Gmail,
   no other mail clients. Clicking it logs the prof via `logOutreachFromDraft()`
   (Drafted) as a best-effort, since we can't confirm the manual send.

### B. "Sent to professor" confirmation

4. On `gmailSendApi` success:
   - Button → "Sent ✓" (existing).
   - **Toast** "Email sent to {Professor name}" (new lightweight toast helper —
     none exists today: a fixed-position `aria-live="polite"` container +
     `showToast(msg)` that auto-dismisses ~3.5s).
   - `logOutreachSent(...)` marks **Sent** + persists (existing).
   - Modal closes after the existing ~1.2s delay.
   - Professor name resolved from `_draftData.professor.name` (fallback "the professor").

### C. Tracker reply Yes/No

5. **Sent-row next action** in `trackerRowHTML`: replace the single "Mark replied"
   link with `Replied yet? [Yes] [No]`.
   - **Yes** → `setStatus(id,'replied')` (existing) → row becomes **Replied**.
   - **No** → `setStatus(id,'notReplied')` (new branch).
   - If `replied===false` already recorded, render a subtle "No reply yet ·
     [Yes] [No]" so the user can still flip to Yes.
6. **Extend `setStatus(id, status)`**:
   - `'replied'` (unchanged): `replied:true`, `repliedAt`.
   - `'notReplied'` (new): set in-session `_outreachReplied[id]=false`,
     `entry.replied=false`, `entry.repliedCheckedAt=Date.now()`, persist
     `logOutreach(id,{replied:false, repliedCheckedAt})`. Stays **Sent**
     (`displayStatus` keeps `replied===false` as sent).
   - Repaint tracker + profile stepper.
   - Note: `logOutreach` currently only writes `replied:true` when the in-session
     mirror is true; writing `replied:false` here is intentional and explicit, and
     is downgrade-proof because `displayStatus` treats `false` as "still sent".

### D. Edge cases / safety

- **Signed out:** client-side Gmail send still works, but `logOutreach*` guards on
  `getAuthUser()`. Keep the guard; if signed out at send time, still send + toast,
  but add a one-line nudge ("Sign in to track this in your tracker"). No crash.
- **Header injection:** To-field value passes through `buildGmailRaw`'s existing
  CR/LF strip; also validated before send.
- **Best-guess sends:** mitigated by the visible, editable, flagged To field — the
  user sees and confirms the address before it goes out.
- **No Firestore-rules change:** all writes are to the existing
  `users/{uid}/outreach/{authorId}` doc the rules already permit.

## Components & touch points (all `index.html`)

| Area | Change |
|------|--------|
| Draft modal markup (~1920–1985) | Add To field above Subject; restructure footer (drop generic mailto, add error-only Gmail link) |
| Toast (new) | CSS + `<div>` container + `showToast()` |
| `loadProfEmail` (~5118) | Record `_bestEmail {address,confidence,isGuess}` incl. best-guess |
| draft open / `getActiveDraft` | Prefill + read the To field |
| `sendViaGmail` (~5036) | Always API-send to To value; validate; remove mailto branch; error-only Gmail escape hatch |
| `logOutreachSent` (~6327) | Fire confirmation toast (otherwise unchanged) |
| `trackerRowHTML` (~6441) | Sent-row Yes/No control |
| `setStatus` (~6423) | Add `'notReplied'` branch |
| CSS | To field, Yes/No buttons, toast, best-guess flag |

## Testing / verification

Manual (no automated frontend harness in repo):
1. Verified-email prof → Send → consent once → toast "Email sent to {Name}" →
   tracker shows **Sent**.
2. Best-guess prof → To field prefilled + flagged → edit if needed → Send → Sent.
3. Sent row → click **No** → stays Sent, shows "No reply yet" + Yes/No remains.
4. Sent row → click **Yes** → moves to **Replied**; persists across reload (Firestore).
5. Consent denied → inline error + "Open in Gmail" link opens prefilled compose.
6. Signed out → send works + toast + sign-in nudge; no crash.

## Out of scope

- Automated reply detection (polling `gmailThreadId`) — remains deferred.
- Server-side send / non-Gmail providers (explicitly Gmail-only).
- Google OAuth app verification (product/ops task, not code).
