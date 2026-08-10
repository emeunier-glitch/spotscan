// SpotScan — indicateurs socio-économiques par commune (emplois, démographie, chômage)
// Proxy serveur : évite tout problème de CORS et agrège 3 sources publiques gratuites.
// GET /api/insee?codes=01043,01024

const EMPLOIS_RES = 'b4f1bb42-ab1b-4493-8639-0b2ab7a9fb3b'; // Indice de concentration de l'emploi (numerateur = emplois)
const CHOMAGE_RES = 'b803ffbc-92cc-4f2f-b919-dcf4a44b21b9'; // Taux de chômage au sens du recensement
const TAB = 'https://tabular-api.data.gouv.fr/api/resources';

// Les arrondissements municipaux n'existent pas dans ces jeux : on remonte à la commune
function normCode(c) {
  c = String(c || '').trim();
  if (/^69(38[1-9])$/.test(c)) return '69123';           // Lyon
  if (/^132(0[1-9]|1[0-6])$/.test(c)) return '13055';    // Marseille
  if (/^751(0[1-9]|1[0-9]|20)$/.test(c)) return '75056'; // Paris
  return c;
}

async function jget(url, ms = 9000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { 'accept': 'application/json' } });
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

// --- Emplois au lieu de travail (recensement 2022) ---
async function emplois(codes) {
  const out = {};
  const url = `${TAB}/${EMPLOIS_RES}/data/?code_com__in=${codes.join(',')}&page_size=50`;
  const d = await jget(url);
  for (const row of (d.data || [])) {
    const code = normCode(row.code_com);
    const an = Number(row.annee) || 0;
    const v = Number(row.numerateur);
    if (!isFinite(v)) continue;
    if (!out[code] || an > out[code].annee) out[code] = { v: Math.round(v), annee: an };
  }
  return out;
}

// --- Taux de chômage (recensement) : on garde les 2 derniers millésimes ---
async function chomage(codes) {
  const out = {};
  const url = `${TAB}/${CHOMAGE_RES}/data/?code_com__in=${codes.join(',')}&page_size=50`;
  const d = await jget(url);
  for (const row of (d.data || [])) {
    const code = normCode(row.code_com);
    const an = Number(row.annee) || 0;
    const num = Number(row.numerateur), den = Number(row.denominateur);
    if (!isFinite(num) || !isFinite(den) || !den) continue;
    if (!out[code] || an > out[code].annee) out[code] = { annee: an, chomeurs: num, actifs: den };
  }
  return out;
}

// --- Populations légales (INSEE Melodi) : série par millésime ---
async function population(codes) {
  const out = {};
  const list = codes.slice(0, 8); // marge sur la limite anonyme de Melodi
  await Promise.all(list.map(async code => {
    try {
      const d = await jget(`https://api.insee.fr/melodi/data/DS_POPULATIONS_REFERENCE?GEO=COM-${code}&POPREF_MEASURE=PMUN&maxResult=200`);
      const series = {};
      for (const o of (d.observations || [])) {
        const dim = o.dimensions || {};
        const per = Number(String(dim.TIME_PERIOD || dim.timePeriod || '').slice(0, 4));
        if (!per) continue;
        const m = o.measures || {};
        let val = null;
        for (const k of Object.keys(m)) {
          const cand = Number(m[k] && m[k].value);
          if (isFinite(cand) && cand > 0) { val = cand; break; }
        }
        if (val != null) series[per] = val;
      }
      if (Object.keys(series).length) out[code] = series;
    } catch (e) { /* commune ignorée, dégradation propre */ }
  }));
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const raw = String((req.query && req.query.codes) || '');
  const codes = [...new Set(raw.split(',').map(normCode).filter(c => /^[0-9AB]{5}$/i.test(c)))].slice(0, 25);
  if (!codes.length) { res.status(400).json({ error: 'Aucun code commune valide' }); return; }

  const [e, c, p] = await Promise.all([
    emplois(codes).catch(() => ({})),
    chomage(codes).catch(() => ({})),
    population(codes).catch(() => ({}))
  ]);

  res.status(200).json({
    emplois: e, chomage: c, population: p,
    sources: {
      emplois: 'INSEE — recensement (emplois au lieu de travail), via data.gouv.fr',
      chomage: 'INSEE — taux de chômage au sens du recensement (15 ans ou plus)',
      population: 'INSEE — populations légales (API Melodi)'
    }
  });
}
