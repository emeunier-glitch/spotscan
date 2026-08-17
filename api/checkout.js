// SpotScan — création d'une session de paiement Stripe Checkout
// Appelle l'API REST Stripe directement (aucune dépendance npm).
// Nécessite la variable d'environnement STRIPE_SECRET_KEY (réglée dans Vercel).

const OFFERS = {
  1: { name: 'SpotScan — Zone de chalandise',        desc: 'Isochrone, population, communes, indice de flux', amount: 1900 },
  2: { name: 'SpotScan — Étude de zone complète',    desc: 'Zone + marché, concurrents (CA, résultat), accès, SWOT', amount: 3900 },
  3: { name: 'SpotScan — Business Plan 18 mois',     desc: 'Étude complète + BP mensuel 18 mois avec moyennes nationales', amount: 7900 }
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Méthode non autorisée' }); return; }

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) { res.status(500).json({ error: 'Paiement non configuré (clé Stripe absente)' }); return; }

  const level = parseInt((req.body && req.body.level) || '0', 10);
  const offer = OFFERS[level];
  if (!offer) { res.status(400).json({ error: 'Offre inconnue' }); return; }

  // Origine de retour : on n'accepte que nos propres domaines
  const ALLOWED = ['https://www.spotscan.fr', 'https://spotscan.fr', 'https://spotscan.vercel.app'];
  const origin = ALLOWED.includes(req.headers.origin) ? req.headers.origin : 'https://www.spotscan.fr';

  const p = new URLSearchParams();
  p.append('mode', 'payment');
  p.append('line_items[0][price_data][currency]', 'eur');
  p.append('line_items[0][price_data][product_data][name]', offer.name);
  p.append('line_items[0][price_data][product_data][description]', offer.desc);
  p.append('line_items[0][price_data][unit_amount]', String(offer.amount));
  p.append('line_items[0][quantity]', '1');
  // Codes promo Stripe : réductions et invitations gérées depuis le tableau de bord,
  // sans redéploiement (un coupon à 100 % rend l'étude gratuite).
  p.append('allow_promotion_codes', 'true');
  p.append('metadata[level]', String(level));
  // Le compte a "Managed Payments" activé par défaut, qui exige un tax_code produit.
  // On le désactive sur cette session (paiement Stripe standard) :
  p.append('managed_payments[enabled]', 'false');
  // Ceinture + bretelles : code fiscal "services fournis par voie électronique"
  p.append('line_items[0][price_data][product_data][tax_code]', 'txcd_10000000');
  p.append('success_url', origin + '/?paid={CHECKOUT_SESSION_ID}');
  p.append('cancel_url', origin + '/?cancel=1');
  p.append('locale', 'fr');

  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: p.toString()
    });
    const data = await r.json();
    if (!r.ok) {
      res.status(502).json({ error: (data.error && data.error.message) || 'Erreur Stripe' });
      return;
    }
    res.status(200).json({ url: data.url });
  } catch (e) {
    res.status(502).json({ error: 'Stripe injoignable : ' + e.message });
  }
}
