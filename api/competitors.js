// SpotScan — moteur de concurrence "terrain d'abord, chiffres ensuite"
// 1) OpenStreetMap (Overpass) : les établissements réellement présents sur le terrain
// 2) SIRENE (recherche-entreprises) : le filtre code APE + les chiffres (CA, résultat, création)
// 3) Union + dédoublonnage des deux sources pour éliminer les oublis
//
// POST /api/competitors  { lat, lon, radiusKm, naf:["93.13Z",...], osm:["leisure=fitness_centre",...] }

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];
const SIRENE = 'https://recherche-entreprises.api.gouv.fr';

const LEGAL = /\b(sarl|sas|sasu|eurl|sci|snc|sa|scop|scm|selarl|earl|gie|ets|etablissements|societe|ste|monsieur|madame|mr|mme)\b/g;

function norm(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(LEGAL, ' ')
    .replace(/\s+/g, ' ').trim();
}
function tokens(s) { return new Set(norm(s).split(' ').filter(w => w.length > 2)); }
function nameClose(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return false;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size) >= 0.5;
}
function haversine(a, b) {
  const R = 6371, dLa = (b[0] - a[0]) * Math.PI / 180, dLo = (b[1] - a[1]) * Math.PI / 180;
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
async function jget(url, ms = 12000, opts = {}) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { accept: 'application/json' }, ...opts });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

/* ---------- 1. Terrain : OpenStreetMap ---------- */
async function fromOSM(lat, lon, radiusM, osmTags) {
  const clauses = osmTags.map(t => {
    const i = t.indexOf('=');
    if (i < 0) return '';
    const k = t.slice(0, i).replace(/"/g, ''), v = t.slice(i + 1).replace(/"/g, '');
    return `nwr["${k}"="${v}"](around:${radiusM},${lat},${lon});`;
  }).join('');
  if (!clauses) return [];
  const q = `[out:json][timeout:22];(${clauses});out center tags;`;

  let data = null, lastErr = null;
  for (const ep of OVERPASS) {
    try {
      data = await jget(ep, 24000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: 'data=' + encodeURIComponent(q)
      });
      break;
    } catch (e) { lastErr = e; }
  }
  if (!data) throw lastErr || new Error('Overpass injoignable');

  const out = [];
  for (const el of (data.elements || [])) {
    const t = el.tags || {};
    const name = t.name || t.brand || t.operator;
    if (!name) continue;                       // sans nom, inexploitable pour le client
    const la = el.lat != null ? el.lat : (el.center && el.center.lat);
    const lo = el.lon != null ? el.lon : (el.center && el.center.lon);
    if (la == null || lo == null) continue;
    const adr = [
      [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' '),
      [t['addr:postcode'], t['addr:city']].filter(Boolean).join(' ')
    ].filter(Boolean).join(', ');
    out.push({ ens: name, adr, lat: Number(la), lon: Number(lo), cp: t['addr:postcode'] || '', src: 'osm' });
  }
  return out;
}

/* ---------- 2. Chiffres : SIRENE par code APE ---------- */
async function fromSirene(lat, lon, radiusKm, naf) {
  const url = `${SIRENE}/near_point?lat=${lat}&long=${lon}&radius=${radiusKm.toFixed(1)}`
    + `&activite_principale=${naf.join(',')}&per_page=25`;
  const d = await jget(url, 12000);
  const out = [];
  for (const r of (d.results || [])) {
    const fin = r.finances ? Object.entries(r.finances).sort((a, b) => b[0] - a[0])[0] : null;
    for (const e of (r.matching_etablissements || [])) {
      if (e.etat_administratif !== 'A') continue;
      if (e.activite_principale && !naf.includes(e.activite_principale)) continue;
      if (!e.latitude || !e.longitude) continue;
      const enseigne = (e.liste_enseignes && e.liste_enseignes[0]) || r.nom_complet || r.nom_raison_sociale;
      out.push({
        ens: enseigne,
        soc: (e.liste_enseignes && e.liste_enseignes[0]) ? (r.nom_raison_sociale || null) : null,
        adr: e.adresse || '',
        created: r.date_creation ? String(r.date_creation).slice(0, 4) : null,
        lat: Number(e.latitude), lon: Number(e.longitude),
        ca: fin ? fin[1].ca : null, rn: fin ? fin[1].resultat_net : null, anF: fin ? fin[0] : null,
        ape: e.activite_principale || null,
        src: 'sirene'
      });
    }
  }
  return out;
}

/* ---------- 3. Enrichissement ciblé d'un point OSM sans correspondance ---------- */
async function enrich(poi, naf) {
  const q = norm(poi.ens);
  if (!q) return null;
  let url = `${SIRENE}/search?q=${encodeURIComponent(q)}&per_page=5&limite_matching_etablissements=5`;
  if (poi.cp) url += `&code_postal=${encodeURIComponent(poi.cp)}`;
  let d;
  try { d = await jget(url, 8000); } catch (e) { return null; }
  for (const r of (d.results || [])) {
    const fin = r.finances ? Object.entries(r.finances).sort((a, b) => b[0] - a[0])[0] : null;
    for (const e of (r.matching_etablissements || [])) {
      if (e.etat_administratif !== 'A') continue;
      if (e.activite_principale && naf.length && !naf.includes(e.activite_principale)) continue;
      const near = (e.latitude && e.longitude)
        ? haversine([poi.lat, poi.lon], [Number(e.latitude), Number(e.longitude)]) < 0.4 : false;
      const sameName = nameClose(poi.ens, (e.liste_enseignes && e.liste_enseignes[0]) || r.nom_complet || '');
      if (!near && !sameName) continue;        // règle : jamais sur le nom seul sans cohérence géo/APE
      return {
        soc: r.nom_raison_sociale || null,
        created: r.date_creation ? String(r.date_creation).slice(0, 4) : null,
        ca: fin ? fin[1].ca : null, rn: fin ? fin[1].resultat_net : null, anF: fin ? fin[0] : null,
        ape: e.activite_principale || null
      };
    }
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Méthode non autorisée' }); return; }

  const b = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}));
  const lat = Number(b.lat), lon = Number(b.lon);
  const radiusKm = Math.min(25, Math.max(0.5, Number(b.radiusKm) || 3));
  const naf = Array.isArray(b.naf) ? b.naf.filter(Boolean) : [];
  const osmTags = Array.isArray(b.osm) ? b.osm.filter(Boolean) : [];
  if (!isFinite(lat) || !isFinite(lon)) { res.status(400).json({ error: 'Coordonnées manquantes' }); return; }

  const warnings = [];
  const [osmRes, sirRes] = await Promise.all([
    fromOSM(lat, lon, Math.round(radiusKm * 1000), osmTags)
      .catch(e => { warnings.push('Recherche terrain (OpenStreetMap) indisponible — seule la source SIRENE a été utilisée.'); return []; }),
    naf.length
      ? fromSirene(lat, lon, radiusKm, naf)
        .catch(e => { warnings.push('Base SIRENE indisponible — les chiffres financiers peuvent manquer.'); return []; })
      : Promise.resolve([])
  ]);

  // Fusion : un point OSM et un établissement SIRENE proches (<150 m) ou de même nom = même commerce
  const used = new Set();
  const merged = [];
  for (const p of osmRes) {
    let best = -1, bestD = 9e9;
    sirRes.forEach((s, i) => {
      if (used.has(i)) return;
      const d = haversine([p.lat, p.lon], [s.lat, s.lon]);
      if (d < 0.15 || (d < 0.5 && nameClose(p.ens, s.ens))) {
        if (d < bestD) { bestD = d; best = i; }
      }
    });
    if (best >= 0) {
      used.add(best);
      const s = sirRes[best];
      merged.push({ ...s, ens: p.ens || s.ens, adr: s.adr || p.adr, lat: p.lat, lon: p.lon, src: 'both' });
    } else {
      merged.push(p);
    }
  }
  sirRes.forEach((s, i) => { if (!used.has(i)) merged.push(s); });

  // Enrichissement des points terrain restés sans chiffres (limité pour tenir le temps de réponse)
  const toEnrich = merged.filter(m => m.src === 'osm').slice(0, 10);
  await Promise.all(toEnrich.map(async m => {
    const info = await enrich(m, naf);
    if (info) Object.assign(m, info, { src: 'both' });
  }));

  // Distance, tri, dédoublonnage
  for (const m of merged) m.dist = haversine([lat, lon], [m.lat, m.lon]);
  merged.sort((a, b2) => a.dist - b2.dist);
  const seen = new Set();
  const comps = merged.filter(m => {
    const k = norm(m.ens) + '|' + Math.round(m.lat * 3000) + '|' + Math.round(m.lon * 3000);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).slice(0, 25);

  res.status(200).json({
    comps, warnings,
    stats: { terrain: osmRes.length, sirene: sirRes.length, retenus: comps.length }
  });
}
