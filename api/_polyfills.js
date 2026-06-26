// Node-serverless polyfills for pdfjs-dist (pulled in by pdf-parse).
//
// pdfjs-dist@5 is built for browsers / Node 22+. Two things break it on Vercel's
// Node 20 runtime, both surfacing only on the server:
//   1. `const SCALE_MATRIX = new DOMMatrix()` runs at module load — DOMMatrix is a
//      browser/Canvas global absent in Node, so the import throws (ReferenceError),
//      crashing every /api route at cold start.
//   2. `Promise.withResolvers` (used heavily) only exists in Node 22+, so actual
//      PDF text extraction would fail on Node 20.
//
// getText() does text extraction only (no canvas rendering), so SCALE_MATRIX is
// never used — a minimal DOMMatrix that simply exists is enough to let the module
// evaluate. This file must be imported before server/index.js (see api/index.js).

if (typeof globalThis.DOMMatrix === 'undefined') {
  class DOMMatrix {
    constructor(init) {
      this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
      this.m11 = 1; this.m12 = 0; this.m13 = 0; this.m14 = 0;
      this.m21 = 0; this.m22 = 1; this.m23 = 0; this.m24 = 0;
      this.m31 = 0; this.m32 = 0; this.m33 = 1; this.m34 = 0;
      this.m41 = 0; this.m42 = 0; this.m43 = 0; this.m44 = 1;
      this.is2D = true; this.isIdentity = true;
      if (Array.isArray(init) && init.length === 6) {
        [this.a, this.b, this.c, this.d, this.e, this.f] = init;
      }
    }
    scale() { return new DOMMatrix(); }
    scaleSelf() { return this; }
    translate() { return new DOMMatrix(); }
    translateSelf() { return this; }
    multiply() { return new DOMMatrix(); }
    multiplySelf() { return this; }
    rotate() { return new DOMMatrix(); }
    rotateSelf() { return this; }
    invertSelf() { return this; }
    transformPoint(p) { return p; }
  }
  globalThis.DOMMatrix = DOMMatrix;
}

if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}
