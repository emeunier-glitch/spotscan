// SpotScan — découpage exact de la zone de chalandise en communes
// Remplace l'approximation "commune la plus proche" par un vrai test point-dans-polygone
// sur les contours officiels des communes (geo.api.gouv.fr).
// Effet de bord voulu : tout point qui n'appartient à aucune commune française est
// identifié comme hors France (Suisse, Belgique, Italie, mer…) et exclu des calculs.
//
// POST /api/zone  { poly:[[lat,lon],...], areaKm2 }

const GEO = 'https://geo.api.gouv.fr';
const DEP_CACHE = new Map(); // réutilisé tant que la fonction reste "chaude"

/* --- Suisse : limites communales swisstopo + repère de revenu cantonal --- */
const CH_LAYER = 'ch.swisstopo.swissboundaries3d-gemeinde-flaeche.fill';
// Revenu brut médian par contribuable (source : administrations fiscales cantonales)
const CH_REVENU = { GE: { v: 62226, an: 2022, lib: 'canton de Genève' } };
const pick = (o, re) => { for (const k of Object.keys(o || {})) if (re.test(k)) return o[k]; return null; };

// La couche swisstopo ne porte pas toujours le nombre d'habitants : on va le chercher sur
// OpenStreetMap, où les communes suisses (relations admin_level=8) sont renseignées par l'OFS.
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];
const UA = 'SpotScan/1.0 (etude-implantation; +https://www.spotscan.fr)';
const normNom = s => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

async function chPopulations(bbox) {
  const [lo0, la0, lo1, la1] = bbox;
  const q = `[out:json][timeout:20];`
    + `rel["boundary"="administrative"]["admin_level"="8"]["population"]`
    + `(${la0.toFixed(4)},${lo0.toFixed(4)},${la1.toFixed(4)},${lo1.toFixed(4)});out tags center;`;
  let data = null;
  for (const ep of OVERPASS) {
    try {
      const c = new AbortController(); const t = setTimeout(() => c.abort(), 12000);
      try {
        const r = await fetch(ep, {
          method: 'POST', signal: c.signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', accept: 'application/json', 'User-Agent': UA },
          body: 'data=' + encodeURIComponent(q)
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        data = await r.json();
      } finally { clearTimeout(t); }
      break;
    } catch (e) { /* mirroir suivant */ }
  }
  if (!data) return { byBfs: new Map(), byNom: new Map() };
  const byBfs = new Map(), byNom = new Map();
  for (const el of (data.elements || [])) {
    const t = el.tags || {};
    const pop = Number(String(t.population || '').replace(/[^0-9]/g, ''));
    if (!pop) continue;
    const an = Number(String(t['population:date'] || '').slice(0, 4)) || null;
    const rec = { pop, an };
    const bfs = t['swisstopo:BFS_NUMMER'] || t['ref:BFS'] || t['ref:bfs'] || t.ref;
    if (bfs) byBfs.set(String(bfs).trim(), rec);
    if (t.name) byNom.set(normNom(t.name), rec);
  }
  return { byBfs, byNom };
}

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

/* Surface approximative d'un anneau lon/lat, en km² */
function ringKm2(ring) {
  let a = 0; const R = 6371;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0] * Math.PI / 180, yi = ring[i][1] * Math.PI / 180;
    const xj = ring[j][0] * Math.PI / 180, yj = ring[j][1] * Math.PI / 180;
    a += (xj - xi) * (2 + Math.sin(yi) + Math.sin(yj));
  }
  return Math.abs(a * R * R / 2);
}

/* Communes suisses touchées par la partie de la zone située hors de France */
async function suisse(ptsHors, cellKm2, bbox) {
  if (!ptsHors.length) return null;
  const [lo0, la0, lo1, la1] = bbox;
  const url = 'https://api3.geo.admin.ch/rest/services/api/MapServer/identify'
    + `?geometry=${lo0},${la0},${lo1},${la1}&geometryType=esriGeometryEnvelope`
    + `&layers=all:${CH_LAYER}&mapExtent=${lo0},${la0},${lo1},${la1}`
    + '&imageDisplay=500,500,96&tolerance=0&sr=4326&returnGeometry=true&limit=50';
  const d = await jget(url, 12000);
  const feats = [];
  for (const f of (d.results || d.features || [])) {
    const a = f.attributes || f.properties || {};
    const g = f.geometry || {};
    const rings = g.rings || (g.coordinates && (g.type === 'MultiPolygon' ? g.coordinates.flat() : g.coordinates));
    if (!rings || !rings.length) continue;
    feats.push({
      nom: pick(a, /^(gemname|name|gem_name|label)$/i) || 'Commune suisse',
      bfs: pick(a, /bfs/i),
      canton: String(pick(a, /^(kanton|ak|kt)$/i) || '').toUpperCase(),
      pop: Number(pick(a, /einwohner|bevoelker|population/i)) || null,
      polys: rings.map(r => [r.map(p => [Number(p[0]), Number(p[1])])]),
      km2: ringKm2(rings[0])
    });
  }
  if (!feats.length) return null;

  const hits = new Map();
  for (const pt of ptsHors) {
    for (const f of feats) {
      if (polyContains(pt, f.polys)) {
        const h = hits.get(f.nom) || { f, n: 0 };
        h.n++; hits.set(f.nom, h); break;
      }
    }
  }
  if (!hits.size) return null;

  // Complément de population : swisstopo ne renvoie pas toujours l'attribut habitants
  let popAn = null;
  if ([...hits.values()].some(h => !h.f.pop)) {
    let src = null;
    try { src = await chPopulations(bbox); } catch (e) { src = null; }
    if (src) for (const h of hits.values()) {
      if (h.f.pop) continue;
      const r = (h.f.bfs && src.byBfs.get(String(h.f.bfs).trim())) || src.byNom.get(normNom(h.f.nom));
      if (r) { h.f.pop = r.pop; if (r.an && (!popAn || r.an > popAn)) popAn = r.an; }
    }
  }

  const communes = [...hits.values()].map(h => {
    const share = h.f.km2 > 0 ? Math.min(1, (h.n * cellKm2) / h.f.km2) : null;
    return {
      nom: h.f.nom, canton: h.f.canton, pop: h.f.pop || null,
      part: share, popIn: (h.f.pop && share) ? Math.round(h.f.pop * share) : null
    };
  }).sort((a, b) => (b.popIn || 0) - (a.popIn || 0));

  const pop = communes.reduce((s, c) => s + (c.popIn || 0), 0);
  const canton = (communes.find(c => c.canton) || {}).canton || '';
  const rev = CH_REVENU[canton] || null;
  const sansPop = communes.filter(c => !c.popIn).length;
  return { communes, pop: pop || null, popAn, canton, revenu: rev, sansPop };
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

  // Grille dense sur la zone (on garde les indices pour reconstituer la géométrie hors France)
  const G = 56, grid = [];
  const dLa = (la1 - la0) / G, dLo = (lo1 - lo0) / G;
  for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) {
    const pt = [lo0 + (j + .5) * dLo, la0 + (i + .5) * dLa];
    if (ringContains(pt, iso)) grid.push({ p: pt, i, j });
  }
  if (!grid.length) { res.status(200).json({ communes: [], pop: 0, horsFrance: 0, points: 0 }); return; }

  // Départements traversés (sondages ; les points hors France ne renvoient rien)
  const probes = [0, .2, .4, .6, .8, 1].map(f => grid[Math.min(grid.length - 1, Math.round(f * (grid.length - 1)))].p);
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
  const horsCells = new Map();   // ligne i -> colonnes j situées hors de France
  const ptsHors = [];
  let dedans = 0, dehors = 0;
  for (const g of grid) {
    const pt = g.p;
    let found = null;
    for (const c of ref) {
      if (pt[0] < c.bbox[0] || pt[0] > c.bbox[2] || pt[1] < c.bbox[1] || pt[1] > c.bbox[3]) continue;
      if (polyContains(pt, c.polys)) { found = c; break; }
    }
    if (!found) {
      dehors++;
      ptsHors.push(pt);
      if (!horsCells.has(g.i)) horsCells.set(g.i, []);
      horsCells.get(g.i).push(g.j);
      continue;
    }
    dedans++;
    const h = hits.get(found.code) || { c: found, n: 0 };
    h.n++; hits.set(found.code, h);
  }

  // Géométrie de la partie hors France : cellules fusionnées en rectangles par ligne
  const horsRects = [];
  for (const [i, cols] of horsCells) {
    cols.sort((a, b2) => a - b2);
    let start = cols[0], prev = cols[0];
    for (let k = 1; k <= cols.length; k++) {
      const j = cols[k];
      if (j !== prev + 1) {
        horsRects.push([
          [+(la0 + i * dLa).toFixed(5), +(lo0 + start * dLo).toFixed(5)],
          [+(la0 + (i + 1) * dLa).toFixed(5), +(lo0 + (prev + 1) * dLo).toFixed(5)]
        ]);
        start = j;
      }
      prev = j;
    }
  }

  const total = dedans + dehors;
  const cellKm2 = areaKm2 / Math.max(1, total);   // maille calibrée sur la surface réelle de la zone
  const communes = [...hits.values()].map(h => {
    const share = Math.min(1, (h.n * cellKm2) / h.c.km2);
    return { nom: h.c.nom, code: h.c.code, share, popIn: Math.round(h.c.pop * share) };
  }).filter(c => c.popIn > 0).sort((a, b2) => b2.popIn - a.popIn);

  // Partie étrangère : identification des communes suisses (n'interrompt jamais le reste)
  let ch = null;
  if (dehors / Math.max(1, total) > 0.02) {
    let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
    for (const p of ptsHors) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
    try { ch = await suisse(ptsHors, cellKm2, [x0, y0, x1, y1]); } catch (e) { ch = null; }
  }

  res.status(200).json({
    communes,
    pop: communes.reduce((a, c) => a + c.popIn, 0),
    suisse: ch,
    horsFrance: total ? dehors / total : 0,
    surfaceFrKm2: areaKm2 * (dedans / Math.max(1, total)),
    horsRects,
    points: total
  });
}
