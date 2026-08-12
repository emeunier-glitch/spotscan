// SpotScan — découpage exact de la zone de chalandise en communes
// Remplace l'approximation "commune la plus proche" par un vrai test point-dans-polygone
// sur les contours officiels des communes (geo.api.gouv.fr).
// Effet de bord voulu : tout point qui n'appartient à aucune commune française est
// identifié comme hors France (Suisse, Belgique, Italie, mer…) et exclu des calculs.
//
// POST /api/zone  { poly:[[lat,lon],...], areaKm2 }

const GEO = 'https://geo.api.gouv.fr';
const DEP_CACHE = new Map(); // réutilisé tant que la fonction reste "chaude"

async function jget(url, ms = 20000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

/* --- géométrie --- */
function ringContains(pt, ring) { // pt = [lon,lat]
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) ins = !ins;
  }
  return ins;
}
function polyContains(pt, polys) {          // polys = [[ringExt, trou1, …], …]
  for (const rings of polys) {
    if (!rings.length || !ringContains(pt, rings[0])) continue;
    let inHole = false;
    for (let k = 1; k < rings.length; k++) if (ringContains(pt, rings[k])) { inHole = true; break; }
    if (!inHole) return true;
  }
  return false;
}
function toPolys(contour) {
  if (!contour || !contour.coordinates) return null;
  return contour.type === 'MultiPolygon' ? contour.coordinates : [contour.coordinates];
}
function bboxOf(polys) {
  let x0 = 180, x1 = -180, y0 = 90, y1 = -90;
  for (const rings of polys) for (const p of rings[0]) {
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
  return [x0, y0, x1, y1];
}

async function loadDep(dep) {
  if (DEP_CACHE.has(dep)) return DEP_CACHE.get(dep);
  const raw = await jget(`${GEO}/departements/${dep}/communes?fields=nom,code,population,surface,contour&format=json`, 25000);
  const list = [];
  for (const c of (raw || [])) {
    const polys = toPolys(c.contour);
    if (!polys) continue;
    list.push({
      nom: c.nom, code: c.code, pop: c.population || 0,
      km2: Math.max(0.5, (c.surface || 1000) / 100),
      polys, bbox: bboxOf(polys)
    });
  }
  DEP_CACHE.set(dep, list);
  return list;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Méthode non autorisée' }); return; }

  const b = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}));
  const poly = Array.isArray(b.poly) ? b.poly : null;         // [[lat,lon],…]
  const areaKm2 = Number(b.areaKm2) || 0;
  if (!poly || poly.length < 4 || !areaKm2) { res.status(400).json({ error: 'Zone manquante' }); return; }

  // Anneau de l'isochrone en [lon,lat] pour réutiliser ringContains
  const iso = poly.map(p => [Number(p[1]), Number(p[0])]);
  let la0 = 90, la1 = -90, lo0 = 180, lo1 = -180;
  for (const p of iso) { if (p[1] < la0) la0 = p[1]; if (p[1] > la1) la1 = p[1]; if (p[0] < lo0) lo0 = p[0]; if (p[0] > lo1) lo1 = p[0]; }

  // Grille dense sur la zone
  const G = 56, grid = [];
  for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) {
    const pt = [lo0 + (j + .5) / G * (lo1 - lo0), la0 + (i + .5) / G * (la1 - la0)];
    if (ringContains(pt, iso)) grid.push(pt);
  }
  if (!grid.length) { res.status(200).json({ communes: [], pop: 0, horsFrance: 0, points: 0 }); return; }

  // Départements traversés (sondages ; les points hors France ne renvoient rien)
  const probes = [0, .2, .4, .6, .8, 1].map(f => grid[Math.min(grid.length - 1, Math.round(f * (grid.length - 1)))]);
  const deps = new Set();
  await Promise.all(probes.map(async pt => {
    try {
      const d = await jget(`${GEO}/communes?lat=${pt[1].toFixed(5)}&lon=${pt[0].toFixed(5)}&fields=codeDepartement`, 8000);
      if (d && d[0] && d[0].codeDepartement) deps.add(d[0].codeDepartement);
    } catch (e) { /* point probablement hors France */ }
  }));
  if (!deps.size) { res.status(200).json({ communes: [], pop: 0, horsFrance: 1, points: grid.length }); return; }

  // Contours des communes des départements concernés
  const ref = [];
  await Promise.all([...deps].slice(0, 4).map(async dep => {
    try { ref.push(...await loadDep(dep)); } catch (e) { /* département ignoré */ }
  }));
  if (!ref.length) { res.status(502).json({ error: 'Contours communaux indisponibles' }); return; }

  // Affectation exacte de chaque point de la grille
  const hits = new Map();
  let dedans = 0, dehors = 0;
  for (const pt of grid) {
    let found = null;
    for (const c of ref) {
      if (pt[0] < c.bbox[0] || pt[0] > c.bbox[2] || pt[1] < c.bbox[1] || pt[1] > c.bbox[3]) continue;
      if (polyContains(pt, c.polys)) { found = c; break; }
    }
    if (!found) { dehors++; continue; }
    dedans++;
    const h = hits.get(found.code) || { c: found, n: 0 };
    h.n++; hits.set(found.code, h);
  }

  const total = dedans + dehors;
  const cellKm2 = areaKm2 / Math.max(1, total);   // maille calibrée sur la surface réelle de la zone
  const communes = [...hits.values()].map(h => {
    const share = Math.min(1, (h.n * cellKm2) / h.c.km2);
    return { nom: h.c.nom, code: h.c.code, share, popIn: Math.round(h.c.pop * share) };
  }).filter(c => c.popIn > 0).sort((a, b2) => b2.popIn - a.popIn);

  res.status(200).json({
    communes,
    pop: communes.reduce((a, c) => a + c.popIn, 0),
    horsFrance: total ? dehors / total : 0,
    surfaceFrKm2: areaKm2 * (dedans / Math.max(1, total)),
    points: total
  });
}
