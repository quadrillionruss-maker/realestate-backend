// satisfactionSurveyService.js — post-handover buyer feedback, SECTION 18.
//
// One survey per reservation, created and sent the moment its handover
// checklist is FIRST marked 'signed_off' (sendForHandover, called from
// handoverService.updateChecklist) — the `unique (reservation_id)`
// constraint (migrations/050) is what makes a later re-save of an
// already-signed-off checklist a no-op rather than a second link.

const { supabaseAdmin } = require('../middleware/orgContext');
const { issuePortalToken, portalUrl } = require('./portalService');
const notify = require('./notificationService');

async function sendForHandover(orgId, reservationId) {
  const { data: existing } = await supabaseAdmin
    .from('re_satisfaction_surveys')
    .select('id')
    .eq('organization_id', orgId)
    .eq('reservation_id', reservationId)
    .maybeSingle();
  if (existing) return { alreadySent: true };

  const { data: reservation } = await supabaseAdmin
    .from('re_reservations')
    .select('id, customer_id, re_customers(id, organization_id, full_name, email, phone, portal_token_version)')
    .eq('id', reservationId)
    .eq('organization_id', orgId)
    .maybeSingle();
  if (!reservation?.re_customers) return { notFound: true };

  const customer = reservation.re_customers;

  const { data: survey, error } = await supabaseAdmin
    .from('re_satisfaction_surveys')
    .insert({ organization_id: orgId, reservation_id: reservationId, customer_id: customer.id })
    .select()
    .single();
  // A concurrent handover-checklist save racing this exact insert hits the
  // same unique index the pre-check above is a courtesy for — read as
  // "already sent", not a failure.
  if (error?.code === '23505') return { alreadySent: true };
  if (error) throw error;

  const token = issuePortalToken(customer);
  const url = `${portalUrl(token)}&survey=${reservationId}`;

  if (customer.email) {
    await notify.sendEmail({
      orgId,
      to: customer.email,
      subject: 'How was your experience with us?',
      html: notify.emailShell({
        heading: 'Thank you for choosing us',
        intro: 'Now that handover is complete, we would love to hear how it went — it takes less than a minute.',
        ctaLabel: 'Share your feedback',
        ctaUrl: url,
        footer: 'This link is personal to you. Do not forward it.',
      }),
      text: `Share your feedback: ${url}`,
      template: 'satisfaction_survey',
      relatedType: 're_satisfaction_surveys',
      relatedId: survey.id,
    });
  }
  if (customer.phone) {
    await notify.sendWhatsApp({
      orgId,
      to: customer.phone,
      body: `Thank you for choosing us! Now that handover is complete, we would love your feedback: ${url}`,
      template: 'satisfaction_survey',
      relatedType: 're_satisfaction_surveys',
      relatedId: survey.id,
    });
  }

  return { survey };
}

async function submit(orgId, reservationId, customerId, { overallScore, constructionQualityScore, salesExperienceScore, comments }) {
  const clamp = (v) => (v == null ? null : Math.max(1, Math.min(5, Math.round(Number(v)))));

  const { data, error } = await supabaseAdmin
    .from('re_satisfaction_surveys')
    .update({
      completed_at: new Date().toISOString(),
      overall_score: clamp(overallScore),
      construction_quality_score: clamp(constructionQualityScore),
      sales_experience_score: clamp(salesExperienceScore),
      comments: comments ? String(comments).trim().slice(0, 2000) : null,
    })
    .eq('organization_id', orgId)
    .eq('reservation_id', reservationId)
    .eq('customer_id', customerId)
    .select()
    .maybeSingle();
  if (error) throw error;
  if (!data) return { notFound: true };
  return { survey: data };
}

// The Reports screen's Satisfaction section: workspace averages + recent
// comments. Averages are computed over COMPLETED surveys only — a sent-but-
// unanswered row has no score to average in, and counting it as a zero
// would understate every workspace's real numbers.
async function summary(orgId) {
  const { data, error } = await supabaseAdmin
    .from('re_satisfaction_surveys')
    .select(`
      overall_score, construction_quality_score, sales_experience_score, comments, completed_at,
      re_customers(full_name)`)
    .eq('organization_id', orgId)
    .not('completed_at', 'is', null)
    .order('completed_at', { ascending: false });
  if (error) throw error;

  const rows = data || [];
  const avg = (key) => {
    const scored = rows.filter((r) => r[key] != null);
    if (!scored.length) return null;
    return Math.round((scored.reduce((sum, r) => sum + r[key], 0) / scored.length) * 10) / 10;
  };

  return {
    completed_count: rows.length,
    average_overall_score: avg('overall_score'),
    average_construction_quality_score: avg('construction_quality_score'),
    average_sales_experience_score: avg('sales_experience_score'),
    recent_comments: rows
      .filter((r) => r.comments)
      .slice(0, 10)
      .map((r) => ({ customer_name: r.re_customers?.full_name || 'A buyer', comments: r.comments, completed_at: r.completed_at })),
  };
}

module.exports = { sendForHandover, submit, summary };
