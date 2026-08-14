# AI Workforce — Deal Manager & Agents

> **STATUS: V2 — IN BUILD as of 2026-08-13.**
> The hard gates below (≥3 paying customers, manual workflow already
> live, Deal Manager auditability) were a v1-era guard against building a
> demo instead of a company. They are explicitly superseded by product
> decision on this date, not silently bypassed — v2 is being built now,
> gated instead by the Deal Manager's own runtime checks (workspace has
> WhatsApp configured, buyer hasn't opted out, a human isn't already
> handling this conversation, nothing sent twice in a day) rather than a
> pre-build checklist. `src/services/dealManager.js` and the five agents
> in `src/services/*Agent.js` are the current implementation of this
> document, run from `src/jobs/daily.js`.

## The organizing idea
Not features — **employees**. Each agent has a scope, tools, and a
reporting line. Nothing acts without the Deal Manager knowing. Humans
approve consequential actions; agents execute routine ones.

## Deal Manager (the CEO — V2 core)
The orchestrator every agent reports to. It owns:
- The unified state: every reservation, buyer, installment, document, task.
- The morning brief and executive summaries (v1's brief job grows into this).
- Routing: deciding which agent handles what, and when to ask a human.
- The audit log: every agent action recorded, attributable, reversible.
- Permissions: an agent acting for a sales rep never sees CEO-only data.

**v1 → v2 path:** today the brief job *reads* state and *drafts* actions.
The Deal Manager upgrade lets it *execute* approved actions (send the
follow-up, generate the letter, schedule the call) and delegate to
specialist agents below.

## Specialist agents (V2+, adapted for Nigerian developers)
| Agent | Scope | Original brokerage-doc equivalent |
|---|---|---|
| **Collections Agent** | Owns overdue installments end-to-end: escalation ladders (gentle WhatsApp → email → call task → management flag), promise-to-pay tracking | Follow-up Agent |
| **Sales Agent** | Lead nurture pre-reservation: inquiry responses, site-visit scheduling, unit recommendations from budget | Buyer Agent |
| **Document Agent** | Allocation letters, contracts of sale, deeds of assignment: generation, delivery, signature chasing, missing-doc alerts | Legal Agent |
| **Finance/Reporting Agent** | Investor & partner reporting, project cash-flow projections from installment schedules, bank-facing summaries | (new) |
| **Scheduling Agent** | Site inspections, allocation ceremonies, buyer meetings | Scheduling Agent |
| **Market Intelligence Agent** | Land/unit price trends by area, competitor launch monitoring, demand signals | Market Intelligence + Pricing Agent |

Deferred until a US/brokerage edition: Buyer Agent (MLS-driven),
Seller Agent, Mortgage Agent, MLS integrations.

## Architecture rules (already respected by v1 code)
1. **Adapters, never direct integration.** Paystack, OpenAI, Resend,
   WhatsApp sit behind service files. Swapping a provider = one file.
2. **Agents share state through the database, not through each other.**
   The schema IS the shared memory. That's why v1's tables carry
   `organization_id` everywhere and why tasks have a `source` column.
3. **Every agent output is a proposal by default — auto-execution is a
   granted permission, not an assumption.** For the v2 build, that
   permission is granted at the workspace level by configuring WhatsApp
   under Settings: an org with no WhatsApp credentials on file gets
   proposals only (tasks, brief items), exactly like v1. Configuring
   WhatsApp is the org's opt-in to the Collections/Document/Sales agents
   actually sending. A future per-action grant (approve this specific
   message before it sends) is a finer-grained version of the same idea,
   not built yet.
4. **One brain.** New agents plug into the Deal Manager's context; we never
   ship nine disconnected chatbots.
5. **The Deal Manager decides before an agent acts, every time.** Configured,
   not already human-handled (a rep replied in the last 24h), not already
   sent today, not opted out — all four, checked fresh per action, not
   cached. See `dealManager.clearance()`.

## Hard gates before building each agent
An agent gets built only when: (a) ≥3 paying customers ask for that job to
be automated, (b) the manual version of the workflow already runs through
the platform, and (c) the Deal Manager can audit it. This keeps us from
building a clever demo instead of a company.
