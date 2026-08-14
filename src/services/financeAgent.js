// financeAgent.js — SECTION 11, v2's Finance Agent.
//
// Reuses investorReportService.getInvestorReport for its numbers — the
// EXACT same figures the Reports screen's investor view already shows, per
// that file's own comment on why it was extracted. This agent's only new
// work is turning those numbers into a PDF and mailing it out on schedule.
//
// "On the 1st of every month at 07:30 Lagos time" is read as "within the
// same 07:00 daily cron pass that already runs for every org" (see
// jobs/daily.js), gated by a same-day-of-month check, rather than a fourth
// distinct cron schedule — by the time the brief and every other agent have
// run for every workspace, the wall clock is already past 07:00 in
// practice, and a dedicated schedule for one monthly send is not worth the
// extra moving part.
const fs = require('fs');
const path = require('path');
const { supabaseAdmin } = require('../middleware/orgContext');
const { renderHtmlToPdf } = require('./pdfAdapter');
const { escapeHtml } = require('../utils/escapeHtml');
const { resolveBranding } = require('./brandingService');
const { getInvestorReport } = require('./investorReportService');
const notify = require('./notificationService');
const dealManager = require('./dealManager');
const { lagosToday, lagosParts } = require('./overdueService');

const AGENT_NAME = 'finance_agent';
const TEMPLATE_PATH = path.join(__dirname, '../templates/investor_report.html');

const naira = (amount) => {
  const n = Number(amount || 0);
  return (n < 0 ? '-' : '') + '₦' + Math.abs(n).toLocaleString('en-NG', { maximumFractionDigits: 0 });
};

function buildInvestorReportHtml(report, branding) {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const companyName = branding.brand_company_name || branding.company_name || branding.full_name || 'Our Company';

  const rows = report.projects.map((p) => `<tr>
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(String(p.units.total))}</td>
      <td>${escapeHtml(String(p.units.sold))}</td>
      <td class="num">${escapeHtml(naira(p.contracted_value))}</td>
      <td class="num">${escapeHtml(naira(p.collected_total))}</td>
      <td class="num">${escapeHtml(naira(p.receivables_overdue))}</td>
    </tr>`).join('');

  return template
    .replace(/{{COMPANY_NAME}}/g, escapeHtml(companyName))
    .replace(/{{PERIOD}}/g, escapeHtml(report.period_end || lagosToday()))
    .replace(/{{TOTAL_GDV}}/g, escapeHtml(naira(report.totals.gross_development_value)))
    .replace(/{{TOTAL_CONTRACTED}}/g, escapeHtml(naira(report.totals.contracted_value)))
    .replace(/{{TOTAL_COLLECTED}}/g, escapeHtml(naira(report.totals.collected_total)))
    .replace(/{{TOTAL_OVERDUE}}/g, escapeHtml(naira(report.totals.receivables_overdue)))
    .replace(/{{ROWS_BLOCK}}/g, rows || '<tr><td colspan="6">No projects on record.</td></tr>')
    .replace(/{{GENERATED_AT}}/g, escapeHtml(new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })));
}

// investor_emails is a comma-separated free-text column (migrations/028) —
// notify_md_email is always included first when set, matching this
// product's other alert routing (overdueAlerts, escalation) already
// treating notify_md_email as the default "someone senior should see this".
function collectRecipientEmails(settings) {
  const extra = String(settings?.investor_emails || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([settings?.notify_md_email, ...extra].filter(Boolean))];
}

async function runForOrg(orgId) {
  const { data: activeProjects } = await supabaseAdmin
    .from('re_projects').select('id').eq('organization_id', orgId).eq('status', 'active').limit(1);
  if (!activeProjects?.length) {
    return { skipped: 'no_active_projects' };
  }

  const { data: settings } = await supabaseAdmin
    .from('re_org_settings')
    .select('notify_md_email, investor_emails, company_name')
    .eq('organization_id', orgId)
    .maybeSingle();

  const recipients = collectRecipientEmails(settings);
  if (!recipients.length) {
    const title = `Set an investor report email before next month's report`;
    const { error } = await supabaseAdmin.from('re_tasks').insert({
      organization_id: orgId, title,
      notes: 'No escalation email or investor emails are configured in Settings, so this month\'s investor report could not be sent.',
      source: 'ai',
    });
    if (error && error.code !== '23505') console.warn('[finance-agent] could not file no-email task:', error.message);
    await dealManager.logAction(orgId, AGENT_NAME, null, 'monthly_investor_report', 'skipped: no_email_configured');
    return { skipped: 'no_email_configured' };
  }

  const report = await getInvestorReport(orgId);
  const branding = await resolveBranding(orgId);
  const html = buildInvestorReportHtml(report, branding);
  const pdf = await renderHtmlToPdf(html);
  const period = report.period_end || lagosToday();

  let sentCount = 0;
  for (const email of recipients) {
    const result = await notify.sendEmail({
      orgId,
      to: email,
      subject: `Investor report — ${period}`,
      html: notify.emailShell({
        heading: 'Monthly investor report',
        intro: `Attached is the investor report for the period ending ${period}.`,
      }),
      text: `Attached is the investor report for the period ending ${period}.`,
      attachments: [{ filename: `investor-report-${period}.pdf`, content: pdf }],
      template: 'finance_agent_investor_report',
    });
    if (result.status === 'sent') sentCount += 1;
  }

  await dealManager.logAction(orgId, AGENT_NAME, null, 'monthly_investor_report', sentCount ? `sent to ${sentCount}` : 'failed');
  return { sent_to: sentCount, recipients: recipients.length };
}

function isDue(when = new Date()) {
  return lagosParts(when).date.slice(-2) === '01';
}

async function runIfDue(orgId, when = new Date()) {
  if (!isDue(when)) return { skipped: 'not_due' };
  return runForOrg(orgId);
}

module.exports = { runForOrg, runIfDue, isDue, buildInvestorReportHtml, collectRecipientEmails };
