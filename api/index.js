// Vercel serverless entry point.
//
// vercel.json rewrites every /api/* request to this file. Vercel preserves the
// original URL, so the imported Express app still routes on /api/recommend,
// /api/health, etc. The app's app.listen() is guarded by `isMainModule`, so the
// import never binds a port — Vercel invokes the exported app as a (req, res)
// handler instead. Non-API routes are served as static index.html by Vercel's
// CDN (see vercel.json), so the app's own SPA fallback is unused here.

// Must run before server/index.js loads pdf-parse → pdfjs-dist (needs DOMMatrix).
import './_polyfills.js';
import { app } from '../server/index.js';

export default app;
