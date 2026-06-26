# Gmail send + reply tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the outreach email feature send silently via the Gmail API to an editable recipient, confirm "Email sent to {Professor}", mark the professor **Sent** in the tracker, and give every Sent row an explicit "Replied yet? Yes / No" control.

**Architecture:** All changes are in the single-file SPA `index.html` (`<script type="module">` at line 2164). We add an editable **To** field to the draft modal, repoint the primary Send button at the Gmail REST API (already implemented in `gmailSendApi`) using that field, add a lightweight toast, and extend the existing downgrade-proof outreach status model with a `replied:false` ("asked, no reply yet") state surfaced as Yes/No buttons in the tracker.

**Tech Stack:** Vanilla HTML/CSS/ES-module JS. Google Identity Services (`gmail.send` scope). Firestore (`users/{uid}/outreach/{authorId}`) via the existing `logOutreach*` helpers. No build step, no server change, no Firestore-rules change.

**Repo facts the implementer must know:**
- The script is a **module** — functions reached from inline `onclick` MUST be assigned to `window` (see the block at ~line 7147). `setStatus`, `toggleSaved`, `trackerDraft`, `logOutreachFromDraft`, `sendViaGmail` are already exposed; the new code reuses those, so **no new `window.` assignment is required.**
- `apiFetch(path)` and the `Map` `_emailCache` already exist in module scope and are reused by the new prefill helper.
- `displayStatus(d)` returns `'replied'` only when `d.replied === true`; `replied === false` falls through to `'sent'` — this is why "No" keeps the row Sent without a downgrade.
- `hydrateOutreachForUser` already rehydrates `_outreachReplied[id] = false` when the doc has `replied:false`, so the No state persists across reload with no extra work.
- There is **no automated frontend test harness** in this repo (only `server/test/*` for the backend). Verification is a browser-harness smoke test (load + zero console errors + screenshots) plus a manual e2e checklist; full Gmail-send e2e needs the user's real Google account and cannot be automated here.

---

### Task 1: Markup + CSS (additive only — nothing removed yet)

**Files:**
- Modify: `index.html` (draft-result markup ~1920, footer/error area ~1961, CSS, end-of-body toast container)

- [ ] **Step 1: Add the editable "To" field above Subject**

In `index.html`, find (~line 1920):

```html
        <div class="draft-result" id="draftResult" style="display:none">
          <div class="draft-field">
            <label>Subject</label>
            <div class="draft-subject" id="draftSubject"></div>
          </div>
```

Replace with (inserts a To field as the first `.draft-field`):

```html
        <div class="draft-result" id="draftResult" style="display:none">
          <div class="draft-field" id="draftToWrap">
            <label>To</label>
            <input type="email" class="draft-to" id="draftTo" autocomplete="off" spellcheck="false" placeholder="professor@university.edu" aria-label="Recipient email">
            <div class="draft-to-note" id="draftToNote" style="display:none"></div>
          </div>
          <div class="draft-field">
            <label>Subject</label>
            <div class="draft-subject" id="draftSubject"></div>
          </div>
```

- [ ] **Step 2: Add the error-only "Open in Gmail" fallback element**

Find (~line 1961):

```html
    <div class="draft-send-error draft-error" id="draftSendError" style="display:none" role="alert"></div>
```

Replace with (adds a hidden fallback link right under the error line):

```html
    <div class="draft-send-error draft-error" id="draftSendError" style="display:none" role="alert"></div>
    <div id="draftSendFallback" style="display:none;margin:2px 20px 0">
      <a id="draftGmailFallback" class="draft-send-fallback" target="_blank" rel="noopener" href="#" onclick="logOutreachFromDraft()">Open in Gmail to send manually →</a>
    </div>
```

- [ ] **Step 3: Add CSS for the To field, toast, and tracker Yes/No buttons**

Find the draft-message CSS rule (search for `.draft-message{font-size:14px`) and insert these rules immediately **before** it:

```css
/* Editable recipient field (Gmail API send target) */
.draft-to{width:100%;font-family:var(--font-d);font-size:15px;font-weight:500;color:var(--n900);background:var(--n50);border:1px solid var(--n200);border-radius:var(--r-md);padding:11px 14px;line-height:1.4}
.draft-to:focus{outline:none;border-color:var(--g600);box-shadow:0 0 0 3px var(--g50)}
.draft-to-note{margin-top:6px;font-size:12px;font-weight:600;color:#92400E}
/* Toast (success confirmations — none existed before) */
.toast-wrap{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2000;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none}
.toast{background:var(--g800);color:#fff;padding:11px 18px;border-radius:10px;font-size:13.5px;font-weight:600;box-shadow:0 10px 30px rgba(8,15,12,.28);opacity:0;transform:translateY(10px);transition:opacity .25s ease,transform .25s ease;max-width:90vw;text-align:center}
.toast.show{opacity:1;transform:none}
/* Tracker "Replied yet?" Yes/No control on Sent rows */
.nact-reply{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.nact-q{font-size:12.5px;font-weight:600;color:var(--n600)}
.rbtn{font-family:var(--font-b);font-size:12px;font-weight:700;border:1px solid var(--n300);background:var(--white);color:var(--n700);border-radius:7px;padding:4px 11px;cursor:pointer;transition:all .15s}
.rbtn:hover{border-color:var(--n400);background:var(--n50)}
.rbtn-yes:hover{border-color:var(--g600);color:var(--g700);background:var(--g50)}
.rbtn-no.on{border-color:var(--n400);background:var(--n100,var(--n50));color:var(--n800)}
```

- [ ] **Step 4: Add the toast container at the end of `<body>`**

Find the closing of the second script / end of body. Search for the last `</script>` then `</body>`. Insert the toast container right before `</body>`:

```html
<div id="toastWrap" class="toast-wrap" aria-live="polite" aria-atomic="true"></div>
</body>
```

(If `</body>` has other elements just before it, place this line immediately before `</body>` regardless.)

- [ ] **Step 5: Sanity-check the file still loads (no automated test exists)**

Run:

```bash
node -e "const s=require('fs').readFileSync('index.html','utf8');const o=(s.match(/<div/g)||[]).length,c=(s.match(/<\/div>/g)||[]).length;console.log('div open',o,'close',c)"
```

Expected: the open/close counts print without error (rough balance check — exact equality is not required because of self-closing/inline cases, but a wild mismatch signals a broken edit).

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat(email): add editable To field, toast container, Yes/No + fallback markup"
```

---

### Task 2: JS helpers (toast, recipient, prefill, Gmail-compose URL)

**Files:**
- Modify: `index.html` — add functions near the Gmail-send block (after `gmailSendApi`, ~line 4622, before `function draftOutreach()`)

- [ ] **Step 1: Add the helper functions**

Find (~line 4622):

```js
  const data = await res.json();
  return { id: data.id, threadId: data.threadId };
}

function draftOutreach() {
```

Insert the following **between** the closing `}` of `gmailSendApi` and `function draftOutreach()`:

```js

// ── Toast (lightweight success confirmations) ──
function showToast(msg) {
  const wrap = document.getElementById('toastWrap');
  if (!wrap) return;
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  wrap.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 320);
  }, 3500);
}

// ── Send recipient (editable To field) ──
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Live value of the To field, with CR/LF collapsed (header-injection hardening,
// mirrors buildGmailRaw's cleaning) and trimmed.
function getSendRecipient() {
  return (document.getElementById('draftTo')?.value || '').replace(/[\r\n]+/g, ' ').trim();
}

// Best mailable address from an /email DTO. Verified/likely real → not a guess;
// institution-pattern → mailable but flagged as a best guess.
function pickBestEmail(d) {
  if (!d || !d.email) return { address: '', isGuess: false };
  if (d.mailtoEnabled) return { address: d.email, isGuess: d.source === 'institution-pattern' };
  return { address: d.email, isGuess: true };
}

// Prefill the To field for `authorId` from the email cache (or fetch once). Entry-point
// agnostic: works whether the modal opened from the profile page or the tracker. Flags
// institution best-guesses. Never clobbers a value the user is actively editing.
async function prefillDraftTo(authorId) {
  const input = document.getElementById('draftTo');
  const note  = document.getElementById('draftToNote');
  if (!input) return;
  input.value = '';
  if (note) { note.style.display = 'none'; note.className = 'draft-to-note'; note.textContent = ''; }
  if (!authorId) return;
  try {
    let d;
    if (_emailCache.has(authorId)) d = _emailCache.get(authorId);
    else { d = await apiFetch(`/api/professor/${authorId}/email`); _emailCache.set(authorId, d); }
    if (document.activeElement === input && input.value) return; // user typed during the await
    const best = pickBestEmail(d);
    if (best.address) {
      input.value = best.address;
      if (best.isGuess && note) {
        note.textContent = 'Best guess — confirm before sending';
        note.style.display = 'block';
      }
    }
  } catch (_) { /* leave empty for manual entry */ }
}

// Prefilled Gmail compose URL — the Gmail-only escape hatch shown on send failure.
function gmailComposeUrl({ to, subject, body }) {
  const p = new URLSearchParams({ view: 'cm', fs: '1', to: to || '', su: subject || '', body: body || '' });
  return `https://mail.google.com/mail/?${p.toString()}`;
}

function showGmailFallback({ to, subject, body }) {
  const wrap = document.getElementById('draftSendFallback');
  const a = document.getElementById('draftGmailFallback');
  if (!wrap || !a) return;
  a.href = gmailComposeUrl({ to, subject, body });
  wrap.style.display = 'block';
}
function hideGmailFallback() {
  const wrap = document.getElementById('draftSendFallback');
  if (wrap) wrap.style.display = 'none';
}
```

- [ ] **Step 2: Verify the helpers parse (logic spot-check via node)**

The helpers are inline in the module and not importable, so copy the two pure ones into a throwaway node check to confirm the logic:

```bash
node -e "
const EMAIL_RE=/^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const pickBestEmail=(d)=>{if(!d||!d.email)return{address:'',isGuess:false};if(d.mailtoEnabled)return{address:d.email,isGuess:d.source==='institution-pattern'};return{address:d.email,isGuess:true};};
console.log(EMAIL_RE.test('a@b.edu'), EMAIL_RE.test('nope'), EMAIL_RE.test(''));
console.log(pickBestEmail({email:'x@u.edu',mailtoEnabled:true,source:'europepmc'}));
console.log(pickBestEmail({email:'g@u.edu',mailtoEnabled:true,source:'institution-pattern'}));
console.log(pickBestEmail({}));
"
```

Expected output:

```
true false false
{ address: 'x@u.edu', isGuess: false }
{ address: 'g@u.edu', isGuess: true }
{ address: '', isGuess: false }
```

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat(email): toast, recipient + best-email prefill, Gmail-compose fallback helpers"
```

---

### Task 3: Rewrite `sendViaGmail` — Gmail API only, validate To, toast, error fallback

**Files:**
- Modify: `index.html` — `resetDraftSendButton` (~5006) and `sendViaGmail` (~5040)

- [ ] **Step 1: Hide the Gmail fallback whenever the send button resets**

Find (~line 5006):

```js
function resetDraftSendButton() {
  const btn = document.getElementById('draftSendBtn');
  if (btn) {
    btn.disabled = false;
    btn.classList.remove('sent');
    const lbl = btn.querySelector('.draft-send-label');
    if (lbl) lbl.textContent = 'Send email';
  }
  const err = document.getElementById('draftSendError');
  if (err) { err.style.display = 'none'; err.textContent = ''; }
}
```

Replace the final two lines' block by adding a `hideGmailFallback()` call:

```js
function resetDraftSendButton() {
  const btn = document.getElementById('draftSendBtn');
  if (btn) {
    btn.disabled = false;
    btn.classList.remove('sent');
    const lbl = btn.querySelector('.draft-send-label');
    if (lbl) lbl.textContent = 'Send email';
  }
  const err = document.getElementById('draftSendError');
  if (err) { err.style.display = 'none'; err.textContent = ''; }
  hideGmailFallback();
}
```

- [ ] **Step 2: Replace the whole `sendViaGmail` function**

Find the full function starting at `async function sendViaGmail() {` (~line 5040) and ending at its closing `}` right before the `// Esc closes the modal.` comment (~line 4973 in the original numbering, i.e. the `}` that precedes `document.addEventListener('keydown'`). Replace the **entire** function body with:

```js
// Primary action: send the active draft through the signed-in user's Gmail (API).
// Gmail-only: validates the editable To field, then calls gmailSendApi. On failure it
// shows an inline error plus a prefilled Gmail-compose escape hatch (still Gmail).
async function sendViaGmail() {
  const btn = document.getElementById('draftSendBtn');
  const { subject, body } = getActiveDraft();
  if (!subject && !body) return;                  // empty compose — nothing to send

  const to = getSendRecipient();
  if (!EMAIL_RE.test(to)) {
    setDraftSendError('Enter a valid email address in the “To” field before sending.');
    document.getElementById('draftTo')?.focus();
    return;
  }

  if (!gmailIsConfigured()) {
    setDraftSendError('Gmail sending isn’t configured yet.');
    showGmailFallback({ to, subject, body });
    return;
  }

  const lbl = btn ? btn.querySelector('.draft-send-label') : null;
  if (btn) {
    btn.disabled = true;
    btn.classList.remove('sent');
    if (lbl) lbl.textContent = 'Sending…';
  }
  const err = document.getElementById('draftSendError');
  if (err) { err.style.display = 'none'; err.textContent = ''; }
  hideGmailFallback();

  try {
    const { id, threadId } = await gmailSendApi({ to, subject, body });
    logOutreachSent({ messageId: id, threadId });
    const name = (_draftData && _draftData.professor && _draftData.professor.name)
      || (document.getElementById('profName')?.textContent || '').trim()
      || 'the professor';
    showToast(getAuthUser()
      ? `Email sent to ${name}`
      : `Email sent to ${name} — sign in to track it`);
    if (btn) {
      btn.classList.add('sent');
      if (lbl) lbl.textContent = 'Sent ✓';
    }
    setTimeout(() => { closeDraftModal(); resetDraftSendButton(); }, 1200);
  } catch (e) {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('sent');
      if (lbl) lbl.textContent = 'Send email';
    }
    const code = e && e.message;
    if (code === 'CONSENT_DENIED') {
      setDraftSendError('Gmail access was not granted. Allow “Send email on your behalf,” or use “Open in Gmail” to send manually.');
    } else if (code === 'GIS_NOT_READY') {
      setDraftSendError('Gmail isn’t ready yet — wait a moment and try again, or use “Open in Gmail.”');
    } else {
      setDraftSendError(`Couldn’t send through Gmail: ${code || 'unknown error'}. Try “Open in Gmail” to send manually.`);
    }
    showGmailFallback({ to, subject, body });
  }
}
```

- [ ] **Step 3: Verify the modified region parses**

Run:

```bash
node --check --input-type=module -e "$(node -e "const s=require('fs').readFileSync('index.html','utf8');const m=s.match(/<script type=\"module\">([\s\S]*?)<\/script>/);process.stdout.write(m?m[1]:'')")" && echo "MODULE PARSES"
```

Expected: `MODULE PARSES` (the module script body is valid JS). If it errors, fix the syntax before continuing.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(email): Gmail-API-only send from editable To field, toast + Gmail fallback on error"
```

---

### Task 4: Prefill the To field on open; remove the dead mailto path

**Files:**
- Modify: `index.html` — `runDraft` (~4946), `composeOwnEmail` (~4787 and ~4802), delete `updateDraftSend` (~4976) and `openMailtoFallback` (~5034), remove `#draftMailtoBtn` element (~1968)

- [ ] **Step 1: Prefill the To field in AI mode**

In `runDraft`, find (~line 4946):

```js
    updateDraftSend();
    typeDraftBody(d.body, token);
```

Replace with:

```js
    prefillDraftTo(authorId);
    typeDraftBody(d.body, token);
```

- [ ] **Step 2: Prefill the To field in compose mode + stop syncing the removed mailto**

In `composeOwnEmail`, find the compose `sync` listener (~line 4787):

```js
      if (subjEl.textContent === '') subjEl.innerHTML = '';
      if (msgEl.textContent === '') msgEl.innerHTML = '';
      updateDraftSend();
      scheduleComposeAutosave();
```

Replace with (drops the `updateDraftSend()` call — the To field is set once on open, not per keystroke):

```js
      if (subjEl.textContent === '') subjEl.innerHTML = '';
      if (msgEl.textContent === '') msgEl.innerHTML = '';
      scheduleComposeAutosave();
```

Then find (~line 4802):

```js
  updateDraftSend();
  renderComposeGuide();   // mirror the profile's 4-part guide into the modal pane
  msgEl.focus();
```

Replace with:

```js
  prefillDraftTo(state.currentAuthorId);
  renderComposeGuide();   // mirror the profile's 4-part guide into the modal pane
  msgEl.focus();
```

- [ ] **Step 3: Delete the now-unused `updateDraftSend` function**

Find and delete this entire block (~lines 4976–4986):

```js
// Keeps the mailto fallback link (#draftMailtoBtn) in sync with the live draft.
// The primary "Send email" button uses the Gmail API instead (see sendViaGmail).
function updateDraftSend() {
  const a = document.getElementById('draftMailtoBtn');
  if (!a) return;
  const { subject, body } = getActiveDraft();
  const to = _profEmail || '';
  const params = `subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  a.href = `mailto:${to}?${params}`;
  a.title = to ? `Open a draft to ${to} in your mail client` : 'Opens an email draft — add their address in your mail client';
}
```

- [ ] **Step 4: Delete the now-unused `openMailtoFallback` function**

Find and delete this entire block (~lines 5033–5038):

```js
// Log intent + open the user's mail client via the mailto fallback link.
function openMailtoFallback() {
  const fallback = document.getElementById('draftMailtoBtn');
  logOutreachFromDraft();
  if (fallback && fallback.href) window.location.href = fallback.href;
}
```

- [ ] **Step 5: Remove the old generic mailto link from the footer**

Find (~line 1968):

```html
        <a class="draft-send-fallback" id="draftMailtoBtn" href="#" onclick="logOutreachFromDraft()">Open in email instead</a>
```

Delete that line entirely (the Gmail-compose fallback added in Task 1 replaces it).

- [ ] **Step 6: Confirm no stragglers reference the removed names**

Run:

```bash
grep -n "updateDraftSend\|openMailtoFallback\|draftMailtoBtn" index.html || echo "CLEAN — no references remain"
```

Expected: `CLEAN — no references remain`.

- [ ] **Step 7: Verify the module still parses**

Run:

```bash
node --check --input-type=module -e "$(node -e "const s=require('fs').readFileSync('index.html','utf8');const m=s.match(/<script type=\"module\">([\s\S]*?)<\/script>/);process.stdout.write(m?m[1]:'')")" && echo "MODULE PARSES"
```

Expected: `MODULE PARSES`.

- [ ] **Step 8: Commit**

```bash
git add index.html
git commit -m "feat(email): prefill To field on draft open; remove dead mailto fallback path"
```

---

### Task 5: Tracker "Replied yet? Yes / No" + `setStatus` "notReplied" branch

**Files:**
- Modify: `index.html` — `setStatus` (~6423) and `trackerRowHTML` sent branch (~6455)

- [ ] **Step 1: Extend `setStatus` to handle the "No" (not-replied) transition**

Find the full function (~line 6422):

```js
// "Mark replied" from a tracker row → persist the reply outcome (derives to 'replied').
function setStatus(id, status) {
  if (status !== 'replied') return;          // only the replied transition is row-driven
  const entry = _ensureSavedEntry(id);
  entry.replied = true;
  entry.repliedAt = entry.repliedAt || Date.now();
  _outreachReplied[id] = true;
  if (id === state.currentAuthorId) renderProfStatus(id);
  renderTracker();
  logOutreach(id, { replied: true, repliedAt: entry.repliedAt });
}
```

Replace the entire function with:

```js
// Row-driven reply outcome from the tracker's Yes/No control.
//   'replied'     → Yes: replied:true  → row becomes Replied.
//   'notReplied'  → No:  replied:false → row STAYS Sent (displayStatus treats false as
//                   sent), recorded so the user can flip to Yes later. Downgrade-proof.
function setStatus(id, status) {
  if (status !== 'replied' && status !== 'notReplied') return;
  const entry = _ensureSavedEntry(id);
  if (status === 'replied') {
    entry.replied = true;
    entry.repliedAt = entry.repliedAt || Date.now();
    _outreachReplied[id] = true;
    if (id === state.currentAuthorId) renderProfStatus(id);
    renderTracker();
    logOutreach(id, { replied: true, repliedAt: entry.repliedAt });
  } else {
    entry.replied = false;
    entry.repliedCheckedAt = Date.now();
    _outreachReplied[id] = false;
    if (id === state.currentAuthorId) renderProfStatus(id);
    renderTracker();
    logOutreach(id, { replied: false, repliedCheckedAt: entry.repliedCheckedAt });
  }
}
```

- [ ] **Step 2: Replace the Sent-row next action with Yes/No buttons**

In `trackerRowHTML`, find (~line 6455):

```js
  } else if (status === 'sent') {
    nextAction = `<div class="nact" style="cursor:pointer" onclick="setStatus('${esc(p.id)}','replied')">Mark replied</div>`;
  } else {
```

Replace with:

```js
  } else if (status === 'sent') {
    const asked = p.replied === false;   // user already answered "No" at least once
    nextAction = `<div class="nact-reply">
      <span class="nact-q">${asked ? 'No reply yet?' : 'Replied yet?'}</span>
      <button type="button" class="rbtn rbtn-yes" onclick="setStatus('${esc(p.id)}','replied')">Yes</button>
      <button type="button" class="rbtn rbtn-no${asked ? ' on' : ''}" onclick="setStatus('${esc(p.id)}','notReplied')">No</button>
    </div>`;
  } else {
```

- [ ] **Step 3: Verify the module still parses**

Run:

```bash
node --check --input-type=module -e "$(node -e "const s=require('fs').readFileSync('index.html','utf8');const m=s.match(/<script type=\"module\">([\s\S]*?)<\/script>/);process.stdout.write(m?m[1]:'')")" && echo "MODULE PARSES"
```

Expected: `MODULE PARSES`.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(tracker): explicit Replied yet? Yes/No on Sent rows (No keeps Sent)"
```

---

### Task 6: Verification — browser-harness smoke test + manual e2e checklist

**Files:**
- None modified (verification only). Server must be running for API-dependent checks.

- [ ] **Step 1: Start the server**

```bash
cd server && node index.js &
```

Wait until it logs that it's listening (default port — check `server/index.js` startup log, typically `http://localhost:3000`).

- [ ] **Step 2: Load the page in the browser harness and check for console errors**

```bash
browser-harness <<'PY'
new_tab("http://localhost:3000/")
wait_for_load()
print(page_info())
# Confirm the new DOM exists and no module syntax error blew up the script
print(js("!!document.getElementById('draftTo')"))      # expect True
print(js("!!document.getElementById('toastWrap')"))    # expect True
print(js("typeof window.setStatus"))                   # expect 'function' (module loaded OK)
capture_screenshot()
PY
```

Expected: `True`, `True`, `function`. A module syntax error would make `window.setStatus` `undefined` — if so, re-open the module-parse check from Task 5 Step 3 and fix.

- [ ] **Step 3: Smoke-test the toast and Gmail-compose URL via the exposed send path**

```bash
browser-harness <<'PY'
# toastWrap should receive a child when a toast is shown. We can't call the
# module-internal showToast directly, so verify the container is wired and empty now.
print(js("document.getElementById('toastWrap').children.length"))   # expect 0 at rest
# Verify the Gmail fallback element exists and is hidden by default
print(js("getComputedStyle(document.getElementById('draftSendFallback')).display"))  # expect 'none'
PY
```

Expected: `0`, then `none`.

- [ ] **Step 4: Manual e2e checklist (requires the user's real Google account — record results)**

Walk through each and confirm:

1. Open a professor with a **verified/likely** email → click **Draft with AI** → To field is prefilled with that address, no "Best guess" note.
2. Open a professor with only an **institution best-guess** → To field is prefilled **and** shows "Best guess — confirm before sending".
3. Click **Send email** → first time, Google consent appears for `gmail.send`; grant it → button shows **Sent ✓**, a toast **"Email sent to {Name}"** appears, modal closes.
4. Go to **Tracker** → that professor shows status **Sent**.
5. On the Sent row, the next-action shows **"Replied yet? [Yes] [No]"**. Click **No** → row stays **Sent**, label becomes **"No reply yet?"**, **No** button is highlighted.
6. Reload the page (signed in) → the row is still **Sent** with the **No** state preserved (Firestore round-trip).
7. Click **Yes** → row moves to **Replied**; reload → still **Replied**.
8. Force an error path: decline the Gmail consent → inline error appears **and** an **"Open in Gmail to send manually →"** link appears that opens a prefilled Gmail compose tab.
9. Empty/clear the To field → click Send → inline "Enter a valid email…" error, field focused, nothing sent.

- [ ] **Step 5: Stop the server**

```bash
kill %1 2>/dev/null; echo "server stopped"
```

- [ ] **Step 6: Final commit (if any verification-driven fixes were made)**

```bash
git add -A
git commit -m "test(email): verify Gmail send + reply tracking end-to-end" || echo "nothing to commit"
```

---

## Notes for the implementer

- **Do not** add a `mailto:` path back — the product decision is **Gmail-only** (API send, with a Gmail-compose URL as the sole error fallback).
- **Do not** change `firestore.rules` or any `server/` file — all writes go to the already-permitted `users/{uid}/outreach/{authorId}` doc via existing helpers.
- `logOutreach` writes `replied:false` correctly because the explicit `fields` argument overrides its `_outreachReplied===true` base spread; `displayStatus` keeps `replied===false` as **Sent**, so this can never downgrade a real reply.
- If the line numbers have drifted (the working tree is active), match on the quoted code, not the numbers.
