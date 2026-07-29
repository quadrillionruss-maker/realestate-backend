// routes/portal.js — the buyer-facing API. Mounted at /api/portal, OUTSIDE
// the staff `authenticate` middleware, because a buyer holds a portal link and
// not a staff token.
//
// The two tokens are not interchangeable in either direction: a portal token
// carries `aud: 're-portal'`, which src/middleware/auth.js never accepts, and
// a staff token has no audience claim, which portalService pins. That is the
// whole security boundary and it is worth stating plainly.
//
// Everything below scopes to the customer resolved FROM THE TOKEN. No handler
// takes a customer id from the URL or the body, because the moment one does,
// changing a digit in a link shows you someone else's payment history.

const express = require('express');
const portal = require('../services/portalService');
const { getDownloadUrl } = require('../services/documentService');
const { initInstallmentPayment } = require('../services/paystackService');
const { auditSystem } = require('../services/auditService');

const router = express.Router();

// The token arrives as a bearer header (the page reads it out of the URL
// fragment once, then keeps it in memory — the fragment is never sent to a
// server, which is why the link is in the hash and not the query string).
async function portalAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : (req.query.token || '');
    req.customer = await portal.verifyPortalToken(token);
    next();
  } catch (err) {
    res.status(err.statusCode || 401).json({ error: err.message });
  }
}

router.use(portalAuth);

router.get('/me', async (req, res, next) => {
  try {
    res.json(await portal.loadPortalAccount(req.customer));
  } catch (e) { next(e); }
});

router.get('/documents/:id/download', async (req, res, next) => {
  try {
    await portal.assertOwnsDocument(req.customer, req.params.id);
    const result = await getDownloadUrl(req.customer.organization_id, req.params.id);
    if (result.notFound) return res.status(404).json({ error: 'Document not found' });
    if (result.notGenerated) return res.status(409).json({ error: 'That document is not ready yet.' });

    // Worth recording: a buyer downloading their own allocation letter is
    // exactly the kind of fact a later dispute turns on.
    auditSystem({
      orgId: req.customer.organization_id,
      actorKind: 'portal',
      actorEmail: req.customer.email,
      action: 'document.downloaded',
      entityType: 're_documents',
      entityId: req.params.id,
      summary: `${req.customer.full_name} downloaded a document from the buyer portal`,
    });

    res.json(result);
  } catch (e) { next(e); }
});

// A buyer paying their own installment without anyone having to send them a
// link is the point of the whole portal. The amount is decided server-side
// from the schedule row — the browser does not get to say what it owes.
router.post('/pay/:scheduleId', async (req, res, next) => {
  try {
    await portal.assertOwnsSchedule(req.customer, req.params.scheduleId);

    const email = req.customer.email || req.body?.email;
    if (!email) {
      return res.status(400).json({ error: 'Paystack needs an email address for the receipt. Add one and try again.' });
    }

    const result = await initInstallmentPayment(
      req.customer.organization_id,
      req.params.scheduleId,
      email
    );

    auditSystem({
      orgId: req.customer.organization_id,
      actorKind: 'portal',
      actorEmail: req.customer.email,
      action: 'payment.initiated',
      entityType: 're_installment_schedule',
      entityId: req.params.scheduleId,
      summary: `${req.customer.full_name} started a payment of ₦${Number(result.amount).toLocaleString('en-NG')} from the buyer portal`,
      metadata: { reference: result.reference, amount: result.amount },
    });

    res.json(result);
  } catch (e) { next(e); }
});

module.exports = router;
