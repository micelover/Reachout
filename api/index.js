// Vercel serverless entry point.
//
// vercel.json rewrites every /api/* request to this file. Vercel preserves the
// original URL, so the imported Express app still routes on /api/recommend,
// /api/health, etc. The app's app.listen() is guarded by `isMainModule`, so the
// import never binds a port — Vercel invokes the exported app as a (req, res)
// handler instead. Non-API routes are served as static index.html by Vercel's
// CDN (see vercel.json), so the app's own SPA fallback is unused here.

// TEMP DIAGNOSTIC: surface any cold-start import failure (e.g. a dependency the
// Vercel bundler failed to trace) in the HTTP response, since Hobby runtime logs
// don't show it. Reverted to a plain re-export once the cause is known.
let handler;
try {
  const mod = await import('../server/index.js');
  handler = mod.app;
} catch (err) {
  const msg = 'COLD_START_IMPORT_ERROR\n' + (err && err.stack ? err.stack : String(err));
  console.error(msg);
  handler = (req, res) => {
    res.statusCode = 500;
    res.setHeader('content-type', 'text/plain');
    res.end(msg);
  };
}

export default handler;
