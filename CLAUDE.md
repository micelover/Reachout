# ReachOut — Professor Discovery Engine

Static frontend (vanilla HTML/CSS/JS) backed by a lightweight Node/Express proxy
over the OpenAlex API, with Anthropic-powered features. The server lives in
`server/`; the site is a single `index.html` at the repo root.

## AI Team Configuration (project-local agents, tuned 2026-06-19)

**Important: YOU MUST USE these subagents when available for the task.**

These agents live in `.claude/agents/` and are **purpose-written for this repo** —
they know `server/index.js`'s conventions (`oaFetch`, `normalizeAuthor`, the cache,
`claude-sonnet-4-6`, the `400`/`502` error contract) and the single-file `index.html`
frontend. Prefer them over any generic global agent of a similar name.

### Detected stack
- **Backend:** Node.js, Express 4 (ES modules), Anthropic SDK, dotenv
- **Frontend:** Vanilla HTML / CSS / JS — single-page `index.html`, no framework
- **Data:** OpenAlex REST API (no key, polite pool); in-memory Map cache (no database)
- **Build tools:** none (plain `node index.js` / `node --watch`)
- **Test tools:** none configured

### Agent assignments (project-local)

| Task | Agent | Notes |
|------|-------|-------|
| API/endpoint design & contracts | `api-architect` | DTO shape, OpenAlex mapping, `400`/`502` semantics |
| Express routes, OpenAlex proxy, cache, Anthropic endpoints | `node-backend-expert` | Knows `oaFetch`/`normalizeAuthor`/the cache; main backend agent |
| `index.html` UI, CSS, vanilla JS, resume/PDF flow | `vanilla-frontend-expert` | Single-page, `apiFetch`/`apiPost`, no framework |
| Code review (all changes) | `code-reviewer` | Security-aware; key-handling, XSS, cache, upstream errors |
| Performance tuning | `performance-optimizer` | Cache hit-rate, OpenAlex fan-out, payload, Anthropic cost |
| Understand a flow end-to-end | `code-archaeologist` | Traces proxy ↔ frontend wiring, file:line anchored |
| Docs / README / this file upkeep | `documentation-specialist` | Keeps endpoint docs honest |
| Multi-tier / larger features | `tech-lead` | Plans and routes across backend + frontend |

The generic global agents (`backend-developer`, `frontend-developer`,
`tech-lead-orchestrator`) and the framework specialists (Django, Rails, React,
Vue, FastAPI, etc.) are **superseded for this repo** — the project-local agents
above replace them. Don't route to the framework specialists here.

### Using these agents — IMPORTANT

These agents live in **`.claude/agents/`** and are only discovered when Claude Code
is started with **this repo as the working directory**. The agent registry is built
once at session start, so:

- **Launch from the project root:** `cd ~/Documents/reachout/website && claude`.
  Starting Claude from your home folder (or anywhere else) will **not** load these —
  the new-named ones (`node-backend-expert`, `vanilla-frontend-expert`, `tech-lead`)
  won't exist, and shared names (`code-reviewer`, `api-architect`, etc.) will fall
  back to the generic global versions instead of these tuned ones.
- **If you edit an agent file mid-session, restart the session** to pick up the change.
- Verify they're loaded by checking that `node-backend-expert` appears in the agent list.

### Sample command
> Try: "@agent-node-backend-expert add a `/api/professor/:id/papers` endpoint with caching"
