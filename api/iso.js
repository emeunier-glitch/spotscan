// SpotScan — isochrone transfrontalière
// L'isochrone IGN (BD TOPO) ne connaît que le réseau routier français : au bord d'une frontière
// elle s'arrête net, ce qui sous-estime massivement la zone réelle (Ferney-Voltaire, Archamps,
// Saint-Louis, Hendaye, Menton...). Cette fonction fournit une isochrone calculée sur un graphe
// routier européen (OpenStreetMap), utilisée uniquement quand la zone touche une frontière.
//
// POST /api/iso { lat, lon, minutes, mode:'car'|'pedestrian' }
// →     { poly:[[lat,lon],...], engine:'ors'|'valhalla' }   ou 502 si aucun moteur n'a répondu

const UA = 'SpotScan/1.0 (etude-implantation; +https://www.spotscan.fr)';

async function post(url, body, ms, headers) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, {
      method: 'POST', signal: c.signal,
      headers: { 'Content-Type': 'application/json', accept: 'application/json', 'User-Agent': UA, ...(headers || {}) },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

/* Récupère l'anneau extérieur le plus grand d'un GeoJSON, en [lat,lon] */
function ring(geojson) {
  const feats = geojson.features || (geojson.type === 'Feature' ? [geojson] : []);
  let best = null, bestN = 0;
  for (const f of feats) {
    const g = f.geometry || f;
    if (!g || !g.coordinates) continue;
    const polys = g.type === 'MultiPolygon' ? g.coordinates : (g.type === 'Polygon' ? [g.coordinates] : []);
    for (const p of polys) {
      const outer = p[0];
      if (outer && outer.length > bestN) { bestN = outer.length; best = outer; }
    }
  }
  if (!best || best.length < 4) return null;
  return best.map(c => [Number(c[1]), Number(c[0])]);
}

/* 1. OpenRouteService — nécessite la variable d'environnement ORS_KEY (offre gratuite) */
async function ors(lat, lon, sec, mode) {
  const key = process.env.ORS_KEY;
  if (!key) return null;
  const profile = mode === 'pedestrian' ? 'foot-walking' : 'driving-car';
  const d = await post(
    `https://api.openrouteservice.org/v2/isochrones/${profile}`,
    { locations: [[lon, lat]], range: [sec], range_type: 'time', smoothing: 5 },
    8000, { Authorization: key }
  );
  const p = ring(d);
  return p ? { poly: p, engine: 'ors' } : null;
}

/* 2. Valhalla public (OpenStreetMap) — sans clé, secours */
async function valhalla(lat, lon, sec, mode) {
  const d = await post(
    'https://valhalla1.openstreetmap.de/isochrone',
    {
      locations: [{ lat, lon }],
      costing: mode === 'pedestrian' ? 'pedestrian' : 'auto',
      contours: [{ time: Math.round(sec / 60) }],
      polygons: true, denoise: 0.4, generalize: 60
    },
    9000
  );
  const p = ring(d);
  return p ? { poly: p, engine: 'valhalla' } : null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Méthode non autorisée' }); return; }

  const b = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}));
  const lat = Number(b.lat), lon = Number(b.lon);
  const minutes = Math.min(60, Math.max(1, Number(b.minutes) || 10));
  const mode = b.mode === 'pedestrian' ? 'pedestrian' : 'car';
  if (!isFinite(lat) || !isFinite(lon)) { res.status(400).json({ error: 'Coordonnées manquantes' }); return; }

  const sec = Math.round(minutes * 60);
  const t0 = Date.now();
  const errs = [];
  for (const engine of [ors, valhalla]) {
    if (Date.now() - t0 > 14000) break;
    try {
      const r = await engine(lat, lon, sec, mode);
      if (r) { res.status(200).json(r); return; }
    } catch (e) { errs.push(String(e && e.message || e).slice(0, 60)); }
  }
  res.status(502).json({ error: 'Aucun moteur transfrontalier disponible', details: errs });
}
