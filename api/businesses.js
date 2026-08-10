// SpotScan — tissu économique de la zone : tous les établissements implantés sur le terrain
// Source : OpenStreetMap (Overpass). Sert à la carte "points bleus" et au repérage des locomotives.
// POST /api/businesses  { lat, lon, radiusKm }

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];
// Overpass exige un User-Agent identifiable : sans lui, les serveurs publics rejettent la requête.
const UA = 'SpotScan/1.0 (etude-implantation; +https://www.spotscan.fr)';

// Enseignes qui structurent une zone commerciale (locomotives)
const LOCO_SHOP = new Set(['supermarket', 'hypermarket', 'department_store', 'mall', 'doityourself',
  'furniture', 'wholesale', 'garden_centre', 'car']);

const CATS = [
  ['restauration', el => ['restaurant', 'fast_food', 'cafe', 'bar', 'pub'].includes(el.amenity)],
  ['commerce', el => !!el.shop],
  ['artisan', el => !!el.craft],
  ['santé', el => ['pharmacy', 'doctors', 'dentist', 'veterinary'].includes(el.amenity)],
  ['service', el => !!el.office || ['bank', 'fuel', 'driving_school', 'post_office'].includes(el.amenity)],
  ['loisir', el => !!el.leisure]
];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Méthode non autorisée' }); return; }

  const b = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}));
  const lat = Number(b.lat), lon = Number(b.lon);
  const radiusKm = Math.min(25, Math.max(0.5, Number(b.radiusKm) || 3));
  if (!isFinite(lat) || !isFinite(lon)) { res.status(400).json({ error: 'Coordonnées manquantes' }); return; }
  const R = Math.round(radiusKm * 1000);

  const q = `[out:json][timeout:20];(`
    + `nwr["shop"](around:${R},${lat},${lon});`
    + `nwr["office"](around:${R},${lat},${lon});`
    + `nwr["craft"](around:${R},${lat},${lon});`
    + `nwr["amenity"~"^(restaurant|fast_food|cafe|bar|pub|pharmacy|bank|fuel|cinema|driving_school|veterinary|dentist|doctors|post_office|marketplace)$"](around:${R},${lat},${lon});`
    + `nwr["leisure"~"^(fitness_centre|sports_centre|bowling_alley|golf_course)$"](around:${R},${lat},${lon});`
    + `);out center 2000;`;

  let data = null, err = null;
  for (const ep of OVERPASS) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 16000);
      const r = await fetch(ep, {
        method: 'POST', signal: c.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', accept: 'application/json', 'User-Agent': UA },
        body: 'data=' + encodeURIComponent(q)
      });
      clearTimeout(t);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      data = await r.json();
      break;
    } catch (e) { err = e; }
  }
  if (!data) { res.status(200).json({ pts: [], error: 'Carte du tissu économique indisponible', detail: String(err && err.message || err) }); return; }

  const pts = [];
  const byCat = {};
  for (const el of (data.elements || [])) {
    const t = el.tags || {};
    const la = el.lat != null ? el.lat : (el.center && el.center.lat);
    const lo = el.lon != null ? el.lon : (el.center && el.center.lon);
    if (la == null || lo == null) continue;
    let cat = 'autre';
    for (const [name, test] of CATS) { if (test(t)) { cat = name; break; } }
    const loco = !!(t.shop && LOCO_SHOP.has(t.shop)) || t.amenity === 'marketplace';
    byCat[cat] = (byCat[cat] || 0) + 1;
    pts.push({
      n: (t.name || t.brand || '').slice(0, 60),
      t: (t.shop || t.amenity || t.office || t.craft || t.leisure || '').slice(0, 30),
      la: Number(Number(la).toFixed(5)), lo: Number(Number(lo).toFixed(5)),
      c: cat, g: loco ? 1 : 0
    });
  }

  res.status(200).json({ pts, byCat, total: pts.length, tronque: pts.length >= 2000 });
}
