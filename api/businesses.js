// SpotScan — tissu économique de la zone : tous les établissements implantés sur le terrain
// Source : OpenStreetMap (Overpass). Sert à la carte "points bleus" et au repérage des locomotives.
// POST /api/businesses  { lat, lon, radiusKm, bbox:[la0,lo0,la1,lo1] }
//
// La requête est bornée par la boîte englobante de l'isochrone plutôt que par un rayon :
// c'est nettement moins coûteux pour Overpass qu'un "around", et le client refiltre de toute
// façon les points sur le polygone exact. Indispensable depuis que les zones transfrontalières
// peuvent atteindre plusieurs centaines de km² (Genève, Bâle) et faisaient expirer la requête.

const OVERPASS = [
  'https://overpass.kumi.systems/api/interpreter',   // le plus rapide sur les grosses emprises
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];
// Overpass exige un User-Agent identifiable : sans lui, les serveurs publics rejettent la requête.
const UA = 'SpotScan/1.0 (etude-implantation; +https://www.spotscan.fr)';
const BUDGET_MS = 38000;   // enveloppe totale, sous la limite de 50 s de la fonction

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

  // Emprise : boîte de l'isochrone si le client l'a transmise, sinon carré autour du point
  let box = null;
  if (Array.isArray(b.bbox) && b.bbox.length === 4 && b.bbox.every(v => isFinite(Number(v)))) {
    const [la0, lo0, la1, lo1] = b.bbox.map(Number);
    if (la1 > la0 && lo1 > lo0 && (la1 - la0) < 2 && (lo1 - lo0) < 2) box = [la0, lo0, la1, lo1];
  }
  if (!box) {
    const dLa = radiusKm / 111, dLo = radiusKm / (111 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
    box = [lat - dLa, lon - dLo, lat + dLa, lon + dLo];
  }
  const BB = box.map(v => Number(v).toFixed(4)).join(',');

  // Surface de l'emprise : au-delà d'un certain volume on allège la requête pour tenir le temps
  const km2 = (box[2] - box[0]) * 111 * (box[3] - box[1]) * 111 * Math.cos(lat * Math.PI / 180);
  const large = km2 > 250;

  const clauses = [
    `nwr["shop"](${BB});`,
    `nwr["amenity"~"^(restaurant|fast_food|cafe|bar|pub|pharmacy|bank|fuel|cinema|driving_school|veterinary|dentist|doctors|post_office|marketplace)$"](${BB});`,
    `nwr["leisure"~"^(fitness_centre|sports_centre|bowling_alley|golf_course)$"](${BB});`
  ];
  // Bureaux et artisans : très nombreux et peu utiles à la lecture de la carte sur une grande zone
  if (!large) clauses.push(`nwr["office"](${BB});`, `nwr["craft"](${BB});`);

  const q = `[out:json][timeout:${large ? 40 : 25}];(${clauses.join('')});out center ${large ? 3000 : 2000};`;

  const t0 = Date.now();
  let data = null, err = null;
  for (const ep of OVERPASS) {
    const reste = BUDGET_MS - (Date.now() - t0);
    if (reste < 8000) break;                       // plus le temps d'un essai sérieux
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), Math.min(reste, 30000));
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
    } catch (e) { err = e; }
  }
  if (!data) {
    res.status(200).json({
      pts: [], error: 'Carte du tissu économique indisponible',
      detail: String(err && err.message || err), large, km2: Math.round(km2)
    });
    return;
  }

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

  res.status(200).json({
    pts, byCat, total: pts.length, large,
    tronque: pts.length >= (large ? 3000 : 2000)
  });
}
