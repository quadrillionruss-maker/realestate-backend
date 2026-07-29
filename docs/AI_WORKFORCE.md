# AI Workforce — Deal Manager & Agents

> **STATUS: V2+ ARCHITECTURE. DO NOT BUILD YET.**
> v1 ships exactly ONE worker: the Sales Operations Manager
> (`src/services/aiBrief.js` + the daily cron). Everything below is the
> documented growth path so v1 decisions stay compatible with it.

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
3. **Every agent output is a proposal by default.** Auto-execution is a
   per-action, per-org permission granted later, never assumed.
4. **One brain.** New agents plug into the Deal Manager's context; we never
   ship nine disconnected chatbots.

## Hard gates before building each agent
An agent gets built only when: (a) ≥3 paying customers ask for that job to
be automated, (b) the manual version of the workflow already runs through
the platform, and (c) the Deal Manager can audit it. This keeps us from
building a clever demo instead of a company.
