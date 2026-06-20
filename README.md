# ReachOut

Professor discovery platform powered by OpenAlex (free, no API key required).

## Running locally

**1. Start the discovery engine (backend proxy):**
```bash
cd server
npm install     # first time only
node index.js   # runs on http://localhost:8787
```

**2. Open the frontend:**
```bash
open index.html   # or just double-click it
```

That's it. The Browse page will load real researchers from OpenAlex.

## API endpoints

| Endpoint | Description |
|---|---|
| `GET /api/health` | Server health check |
| `GET /api/discover?field=robotics&page=1&per_page=12` | Search researchers by field |
| `GET /api/professor/:authorId` | Full profile + recent papers |

## How it works

1. The frontend sends a field query (e.g. "machine learning") to the local proxy.
2. The proxy resolves the field → an OpenAlex topic ID, then fetches researchers filtered to:
   - Education-type institutions (universities only)
   - Minimum 5 published works (filters disambiguation noise)
   - Sorted by citation count (most impactful first)
3. Clicking a professor card fetches their full profile + up to 5 recent papers.

Data comes from [OpenAlex](https://openalex.org) — a free, open index of academic works.
