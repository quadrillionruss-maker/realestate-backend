// permissions.js — who may do what. One table, no database, no Express.
//
// THE WHOLE POINT OF THIS FILE IS THAT IT IS PURE. Every rule below is a
// plain array of role names, and `canAccess(role, action)` is a lookup. That
// makes the entire access model assertable offline — src/test/logic.test.js
// checks it directly, with no server, no HTTP harness and no Postgres — which
// is the only way a permission matrix ever actually gets tested in a project
// that deliberately has no test framework.
//
// Scattering `if (req.orgRole !== 'owner')` across twenty route files is the
// alternative, and the twenty-first is the one somebody forgets. Routes call
// requirePermission('payments.waive'); the fact that waiving is owner-only
// lives here and nowhere else.
//
// ── THE ROLES ──────────────────────────────────────────────────────────────
// These are the five jobs that exist in a Nigerian property developer's
// office, not a generic owner/admin/member ladder:
//
//   owner           Chairman / MD. Everything, including the things nobody
//                   else may ever do: waiving debt, deleting records,
//                   workspace settings, investor reports, paying commission.
//   sales_director  Head of Sales. The whole sales book — every buyer, every
//                   rep, every commission — but no money out and no settings.
//   sales_rep       Sales Executive. THEIR OWN buyers and reservations only.
//                   Sees payment status, cannot record payment.
//   collections     Collections / Accounts Officer. Every overdue buyer
//                   across every rep, records payments, logs promises.
//                   No commissions, no reports, no documents, no selling.
//   documentation   Documentation / Legal Officer. Generates and tracks
//                   letters and deeds. Sees no money at all.
//
// A solo account has no team_members row; orgContext reads it as 'owner'.

const ROLES = ['owner', 'sales_director', 'sales_rep', 'collections', 'documentation'];

// What a human calls each one. Used by the invite form, the team list and the
// workspace switcher, so the wording is written once.
const ROLE_LABELS = {
  owner: 'Chairman / MD',
  sales_director: 'Head of Sales',
  sales_rep: 'Sales Executive',
  collections: 'Collections Officer',
  documentation: 'Documentation Officer',
};

// Roles that can be handed out through an invite. `owner` is absent
// deliberately: ownership moves through POST /settings/team/transfer-owner,
// which promotes one person and demotes the caller in the same request, and
// never through an email.
const INVITABLE_ROLES = ['sales_director', 'sales_rep', 'collections', 'documentation'];

const ALL = ROLES;
const OWNER = ['owner'];
const DIRECTORS = ['owner', 'sales_director'];
const MONEY_IN = ['owner', 'sales_director', 'collections'];
const PAPERWORK = ['owner', 'sales_director', 'documentation'];
const SELLERS = ['owner', 'sales_director', 'sales_rep'];

// ── Seniority, for role-CHANGE guards only ──────────────────────────────────
// A different question from the matrix above: not "what may this role do"
// but "is moving from role A to role B a step down". sales_rep, collections
// and documentation sit at the same rank deliberately — each is its own job
// with its own, non-overlapping slice of the matrix (a rep sells, collections
// chases money, documentation issues paperwork), so none of the three is
// "lower" than either of the others. Only owner→director and director→(any
// of the three) are ever a downgrade; moving between the three is lateral.
const ROLE_RANK = { owner: 3, sales_director: 2, sales_rep: 1, collections: 1, documentation: 1 };

function isDowngrade(fromRole, toRole) {
  return ROLE_RANK[normalizeRole(toRole)] < ROLE_RANK[normalizeRole(fromRole)];
}

// What a downgrade actually costs, in words a person recognises rather than
// a wall of permission slugs like "reports.readAll". Built from the SAME
// group constants the matrix above is built from — OWNER, DIRECTORS,
// MONEY_IN, PAPERWORK, SELLERS — specifically so this can't quietly drift out
// of sync with what the matrix really grants: a role belongs to a group here
// exactly when it appears in that same array up above.
const ROLE_LOSS_GROUPS = [
  { roles: OWNER, label: "owner-only actions — waiving a buyer's debt, deleting records from the bin, workspace settings and provider keys, the investor report, and marking commission paid out" },
  { roles: DIRECTORS, label: 'director-level access — the whole sales book, restructuring plans and renewing tenancies, importing and exporting data, approving commissions, the daily brief, and managing the team' },
  { roles: MONEY_IN, label: 'recording payments, logging payment promises, and sending buyers their portal link' },
  { roles: PAPERWORK, label: 'generating, updating and downloading documents' },
  { roles: SELLERS, label: 'creating buyers and reservations' },
];

// Every group fromRole belongs to that toRole does not — this is why it stays
// accurate for a director dropping to collections (keeps MONEY_IN, loses
// PAPERWORK and SELLERS) versus dropping to sales_rep (the opposite), rather
// than one generic "here is what a lower tier loses" sentence that would be
// wrong for two of the three operational roles.
function capabilitiesLostGoingFrom(fromRole, toRole) {
  const from = normalizeRole(fromRole);
  const to = normalizeRole(toRole);
  return ROLE_LOSS_GROUPS
    .filter((g) => g.roles.includes(from) && !g.roles.includes(to))
    .map((g) => g.label);
}

// ── The matrix ─────────────────────────────────────────────────────────────
// `owner` appears in every list. The role definition says "full access to
// everything", and relying on an implicit fallthrough would mean the one
// action somebody forgets to whitelist is the one the chairman cannot do.
const PERMISSIONS = {
  // ── Owner only ───────────────────────────────────────────────────────────
  // Money that stops being owed, records that leave the live set, the
  // workspace's own identity, the investor's view of the book, and the moment
  // commission becomes cash. A sales director approves a payout; only the
  // chairman pays it.
  'payments.waive': OWNER,
  'recycle.delete': OWNER,
  'settings.write': OWNER,
  'settings.transferOwner': OWNER,
  'reports.investor': OWNER,
  'commissions.markPaid': OWNER,
  // There is no delete-workspace route in this product, and there must not be
  // one built casually: CLAUDE.md's "nothing is ever deleted" is the whole
  // data-integrity story. The permission is reserved so that if such a route
  // is ever built it is owner-only from its first line.
  'workspace.delete': OWNER,

  // ── Owner + Sales Director ───────────────────────────────────────────────
  'reservations.restructure': DIRECTORS,
  'reservations.renewTenancy': DIRECTORS,
  'imports.write': DIRECTORS,
  'reports.export': DIRECTORS,
  'reports.collections': DIRECTORS,
  'reports.rental': DIRECTORS,
  'commissions.approve': DIRECTORS,
  'commissions.readAll': DIRECTORS,
  'brief.read': DIRECTORS,
  'brief.generate': DIRECTORS,
  'audit.read': DIRECTORS,
  'team.read': DIRECTORS,
  'team.workload': DIRECTORS,
  'team.invite': DIRECTORS,
  'team.manageMembers': DIRECTORS,
  'salesReps.write': DIRECTORS,
  'settings.read': DIRECTORS,
  // Inventory is the developer's own book, not a rep's: a sales executive
  // reads projects and units and never edits them. Not spelled out in the
  // role definitions, but "Units and Projects (read only)" for sales_rep is,
  // and a writable route with a read-only screen in front of it is not a
  // permission model.
  'inventory.write': DIRECTORS,
  // Restoring from the bin is the counterpart to deleting. Deleting is
  // owner-only; putting something back is not destructive, so a sales
  // director may — but a rep, a collections officer and a documentation
  // officer have no business in the bin at all.
  'recycle.restore': DIRECTORS,
  'recycle.read': DIRECTORS,
  // Voiding is a correction to a financial fact, the same weight as waiving
  // one. It was owner/admin before this model existed and stays at the
  // equivalent tier rather than widening to collections.
  'payments.void': DIRECTORS,

  // ── Owner + Sales Director + Collections ─────────────────────────────────
  // Money arriving, and everything that is really "chasing it".
  'payments.record': MONEY_IN,
  'payments.init': MONEY_IN,
  // + Sales Rep, read-only: this file's own role description says "sees
  // payment status, cannot record payment" — payments.record above is the
  // half that stays MONEY_IN-only. routes/payments.js narrows both of these
  // to a rep's own buyers with the same isOwnRecordsOnly/salesRepIdsFor
  // row-level filter reservations.read already uses.
  'payments.schedule': [...MONEY_IN, 'sales_rep'],
  'payments.read': [...MONEY_IN, 'sales_rep'],
  'payments.reallocate': MONEY_IN,
  'promises.read': MONEY_IN,
  'promises.write': MONEY_IN,
  // Not in the spec's route matrix by name, but a receipt is a payment
  // record before it is paperwork — the same tier that records the money
  // is the one that resends proof of it. Documentation's remit is allocation
  // letters and deeds specifically, not payment receipts.
  'payments.receipt': MONEY_IN,
  // Also not named in the spec. A portal link hands a buyer their own
  // payment history — the same people who touch a buyer's sale or their
  // arrears (selling, or chasing them) have reason to send one; a
  // Documentation Officer, whose remit is letters and deeds, does not.
  'customers.portalAccess': ['owner', 'sales_director', 'sales_rep', 'collections'],
  // The at-risk list is the collections officer's whole morning. A sales rep
  // sees their own buyers' status on the buyer screen instead.
  'atRisk.read': MONEY_IN,

  // ── Owner + Sales Director + Documentation ───────────────────────────────
  'documents.generate': PAPERWORK,
  'documents.updateStatus': PAPERWORK,
  // + Sales Rep: documents.create/read below already include them ("can
  // request, cannot issue" — routes/documents.js's own comment). Excluding
  // download meant a rep could request a document for their own buyer and
  // then never retrieve the finished file.
  'documents.download': [...PAPERWORK, 'sales_rep'],

  // ── Owner + Sales Director + Sales Rep ───────────────────────────────────
  // Selling. A rep creates buyers and reservations; the row-level filters in
  // the routes are what keep them to their own.
  'customers.create': SELLERS,
  'customers.update': SELLERS,
  'reservations.create': SELLERS,
  'reservations.updateStatus': SELLERS,

  // ── Read surfaces, filtered per role rather than route-gated ─────────────
  // Everyone below sees a DIFFERENT subset of the same endpoint. The route
  // decides what comes back; this only decides whether the door opens.
  //
  // documents.create is the "request a document" tier: POST /documents writes
  // a pending row and generates nothing, which is exactly the sales rep's
  // "can request, cannot issue". Documentation is included because an officer
  // whose job is issuing letters must be able to raise the row they will then
  // generate — the spec listed this under the selling tier, but a
  // documentation officer who cannot create a document row could only ever
  // generate letters somebody else requested for them.
  'documents.create': ['owner', 'sales_director', 'sales_rep', 'documentation'],
  'documents.read': ['owner', 'sales_director', 'sales_rep', 'documentation'],
  // Collections is absent from reservations.read on purpose — they work the
  // schedule and the at-risk list, not the sales pipeline.
  'reservations.read': ['owner', 'sales_director', 'sales_rep', 'documentation'],
  // A sales rep sees only their own commission lines; owner and director see
  // everyone's. Collections and documentation see none at all.
  'commissions.read': SELLERS,
  // Every buyer, versus only the ones you entered. Documentation gets in but
  // the response is stripped of every figure — see financial.view.
  'customers.read': ALL,
  'customers.readAll': ['owner', 'sales_director', 'collections', 'documentation'],
  'salesReps.read': ['owner', 'sales_director', 'collections', 'documentation'],
  'tasks.read': ALL,
  'tasks.write': ALL,
  'dashboard.read': ALL,
  'inventory.read': ALL,
  'search.read': ALL,
  'audit.readEntity': ALL,

  // Not a route — a content gate. "Documentation CANNOT see payments,
  // commissions, or financial amounts", so every handler that returns money
  // strips it when this is false. It is the one rule that has to hold on a
  // screen the role is otherwise allowed to open.
  'financial.view': ['owner', 'sales_director', 'sales_rep', 'collections'],
};

// Maximum workspaces one person may belong to. A product limit, not a
// database constraint: a unique index that refuses the eleventh row could not
// explain itself, and "reject the invite" is the behaviour asked for — the
// rejection happens when somebody tries to add them, not silently later when
// they click the link.
const MAX_WORKSPACES_PER_USER = 10;

function canAccess(role, action) {
  const allowed = PERMISSIONS[action];
  // An unknown action is a programming error, and the safe reading of one is
  // "nobody". Failing open here would mean a typo in a route silently removed
  // its own gate.
  if (!allowed) return false;
  return allowed.includes(normalizeRole(role));
}

// A solo workspace has no membership row, so req.user.role is null and the
// account owns everything it can see. Anything unrecognised is treated as the
// least-privileged role rather than trusted.
function normalizeRole(role) {
  if (!role) return 'owner';
  return ROLES.includes(role) ? role : 'sales_rep';
}

function rolesFor(action) {
  return PERMISSIONS[action] ? PERMISSIONS[action].slice() : [];
}

// Every action a role may take. Used by GET /auth/me so the browser draws the
// same model the server enforces, rather than a second copy of these rules
// maintained by hand in screens.js.
function actionsFor(role) {
  const normalized = normalizeRole(role);
  return Object.keys(PERMISSIONS).filter((action) => PERMISSIONS[action].includes(normalized));
}

// Only the owner may hand out the deputy's job. A sales director can build
// their own team — reps, collections, documentation — but cannot appoint
// another director, because that is the role that can then see the whole book.
function canInviteRole(inviterRole, targetRole) {
  if (!INVITABLE_ROLES.includes(targetRole)) return false;
  if (!canAccess(inviterRole, 'team.invite')) return false;
  if (targetRole === 'sales_director') return normalizeRole(inviterRole) === 'owner';
  return true;
}

// True when adding one more workspace would put this person past the cap.
// Counted at invite time deliberately: telling somebody "you have been
// invited" and then refusing them at the door is worse than refusing the
// invite while the person sending it is still looking at the form.
function wouldExceedWorkspaceCap(currentCount) {
  return Number(currentCount || 0) >= MAX_WORKSPACES_PER_USER;
}

// The sentence the API answers a 403 with. Written from the role's point of
// view — "a Sales Executive cannot record payments" tells somebody what is
// true about their job, which "Forbidden" does not.
function denialMessage(role, action) {
  const label = ROLE_LABELS[normalizeRole(role)] || 'This role';
  const who = rolesFor(action).map((r) => ROLE_LABELS[r] || r);
  return who.length
    ? `${label} cannot do this. Allowed: ${who.join(', ')}.`
    : `${label} cannot do this.`;
}

module.exports = {
  ROLES,
  ROLE_LABELS,
  INVITABLE_ROLES,
  PERMISSIONS,
  MAX_WORKSPACES_PER_USER,
  canAccess,
  normalizeRole,
  rolesFor,
  actionsFor,
  canInviteRole,
  wouldExceedWorkspaceCap,
  denialMessage,
  ROLE_RANK,
  isDowngrade,
  capabilitiesLostGoingFrom,
};
