// SpotScan — vérification d'un paiement Stripe Checkout au retour du client
// GET /api/verify?session_id=cs_...  →  { paid: true, level: 3 }  ou  { paid: false }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const key = process.env.STRIPE_SECRET_KEY;
  const id = String((req.query && req.query.session_id) || '');

  if (!key) { res.status(500).json({ paid: false, error: 'Paiement non configuré' }); return; }
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(id)) { res.status(400).json({ paid: false, error: 'Session invalide' }); return; }

  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(id), {
      headers: { 'Authorization': 'Bearer ' + key }
    });
    const d = await r.json();
    if (r.ok && d.payment_status === 'paid') {
      res.status(200).json({ paid: true, level: parseInt((d.metadata && d.metadata.level) || '0', 10) });
    } else {
      res.status(200).json({ paid: false });
    }
  } catch (e) {
    res.status(502).json({ paid: false, error: 'Stripe injoignable' });
  }
}
