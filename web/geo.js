/* Pure geometry helpers — no DOM, no network. Shared by the app and the
 * Node test in build/test_geo.js, so both exercise the same code. */

const inBbox = (x, y, b) => !!b && x >= b[0] && y >= b[1] && x <= b[2] && y <= b[3];

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// rings[0] is the outer boundary; the rest are holes.
function pointInPoly(x, y, rings) {
  if (!pointInRing(x, y, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) if (pointInRing(x, y, rings[i])) return false;
  return true;
}

const polysOf = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);

function pointInGeom(x, y, g) {
  if (!g) return false;
  return g.type === 'Polygon'
    ? pointInPoly(x, y, g.coordinates)
    : g.coordinates.some((p) => pointInPoly(x, y, p));
}

// Shortest distance in metres from a point to a geometry's boundary, using a
// local equirectangular projection (accurate over the few km that matter here).
function distToBoundary(x, y, g) {
  const kx = 111320 * Math.cos((y * Math.PI) / 180), ky = 110574;
  let best = Infinity;
  for (const rings of polysOf(g)) {
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const ax = (ring[j][0] - x) * kx, ay = (ring[j][1] - y) * ky;
        const bx = (ring[i][0] - x) * kx, by = (ring[i][1] - y) * ky;
        const dx = bx - ax, dy = by - ay;
        const len = dx * dx + dy * dy;
        let t = len ? -(ax * dx + ay * dy) / len : 0;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(ax + t * dx, ay + t * dy);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

// Straight-line distance in metres between two lon/lat pairs.
function distMeters(x1, y1, x2, y2) {
  const kx = 111320 * Math.cos(((y1 + y2) / 2 * Math.PI) / 180), ky = 110574;
  return Math.hypot((x2 - x1) * kx, (y2 - y1) * ky);
}

function fmtDist(m) {
  return m < 1000 ? `mita ${Math.round(m / 10) * 10}` : `km ${(m / 1000).toFixed(1)}`;
}

if (typeof module !== 'undefined') {
  module.exports = {
    inBbox, pointInRing, pointInPoly, polysOf, pointInGeom, distToBoundary,
    distMeters, fmtDist,
  };
}
