# HubSpot Automations

GitHub Actions–powered HubSpot sync scripts replacing the previous Pipedream workflows.

## Workflows

| Workflow | Schedule | What it does |
|---|---|---|
| `expansion-sync` | Every hour (on the hour) | Finds Expansion Closed Won deals not yet synced → adds amount + products to the company's Active Subscription deal |
| `full-cancellation-sync` | Every hour (at :15) | Finds Takedown Completed tickets with scope `Full customer cancellation` → moves the company's Active Subscription deal to Ended Subscription |
| `cancellation-sync` | Every hour (at :30) | Finds partial cancellation tickets (Takedown Completed, scope not `Full customer cancellation`) not yet synced → removes amount + products from the company's Active Subscription deal |
| `failed-pay-sync` | Every hour (at :45) | Finds Failed pay tickets at Takedown Completed → moves the company's Active Subscription deal to Ended Subscription |
| `discount-sync` | Every hour (at :50) | Finds **Cancellation deals** at `Sub lost` with scope `Referral discount` or `Retention discount` → subtracts `cancelled_amount` from the company's Active Subscription deal amount |

### Ticket-driven vs deal-driven

Every sync except `discount-sync` is triggered by a **ticket** reaching a Takedown Completed
stage. `discount-sync` is triggered by the **cancellation deal** reaching `Sub lost`, because
referral and retention discounts bypass the ticketing side of the process entirely — there is
no takedown work to do, so no ticket is raised and the deal never reaches
`Closed - Notice period running`.

**This makes one HubSpot-side change mandatory:** the workflow that raises cancellation
tickets must exclude `Referral discount` and `Retention discount`
(`Cancellation scope is none of ...`). If a ticket is raised for one of these deals anyway,
`cancellation-sync` will subtract the same amount a second time. The two scripts track
processed state on different objects (`discount_synced` on the deal vs `cancellation_synced`
on the ticket) and cannot see each other's work.

`discount-sync` also leaves the `product` field alone — a discount reduces the price of the
same subscription rather than removing anything from it.

## How processed state is tracked

Both scripts use a HubSpot property to mark records as processed rather than an external state file:

- **Expansion deals** → `expansion_synced` (boolean, on Deals)
- **Cancellation tickets** → `cancellation_synced` (boolean, on Tickets)
- **Failed pay tickets** → `failed_pay_synced` (boolean, on Tickets)
- **Discount cancellation deals** → `discount_synced` (boolean, on Deals)

A deal/ticket is only processed once. If a run fails mid-way, unprocessed records are retried on the next hourly run.

Each script filters on `NOT_HAS_PROPERTY` for its own marker, so a record that is skipped
because of a data problem (missing amount, duplicate subscription) is retried every hour
until the data is fixed — no manual re-run needed.

## Setup

### 1. Add the GitHub Secret

Go to **Settings → Secrets and variables → Actions → New repository secret**:

- Name: `HUBSPOT_ACCESS_TOKEN`
- Value: your HubSpot private app token

### 2. Enable Actions

Go to the **Actions** tab and confirm workflows are enabled.

### 3. Test manually

Click **Run workflow** on either workflow to trigger a run outside the schedule.

## Running locally

```bash
HUBSPOT_ACCESS_TOKEN=pat-eu1-xxx node scripts/expansion-sync.mjs
HUBSPOT_ACCESS_TOKEN=pat-eu1-xxx node scripts/cancellation-sync.mjs
HUBSPOT_ACCESS_TOKEN=pat-eu1-xxx node scripts/full-cancellation-sync.mjs
HUBSPOT_ACCESS_TOKEN=pat-eu1-xxx node scripts/failed-pay-sync.mjs
HUBSPOT_ACCESS_TOKEN=pat-eu1-xxx node scripts/discount-sync.mjs
```

## HubSpot config

Portal `147829287` (EU — `app-eu1.hubspot.com`), company currency GBP.

**Deal pipelines**

- Subscriptions pipeline: `3773293783`
  - Active Subscription: `5277843668`
  - Ended Subscription: `5277843669`
- Expansion pipeline: `3729013995`
  - Expansion Closed Won: `5215212757`
- Cancellation pipeline: `3871606001`
  - Cancellation Requested: `5508107480`
  - Save action in progress: `5508107481`
  - Pending customer decision: `5508107482`
  - Closed - Notice period running: `5508107483`
  - Closed - Saved: `5508107484`
  - Sub lost: `5872711925`

**Ticket pipelines**

- Cancellation ticket pipeline: `3789971681`
  - Closed-Churn: `5308124360`
  - Closed-Unsavable: `5384911081`
- Cancellation - test ticket pipeline: `3871606003`
  - Closed - Takedown completed: `5508107496`
- Failed pay ticket pipeline: `3871571168`
  - Closed - Takedown completed: `5508115696`

**`cancellation_scope` values** (enumeration; stored as labels, not internal codes)

| Value | Handled by |
|---|---|
| `Product downgrade` | `cancellation-sync` (ticket-driven) |
| `Product cancellation` | `cancellation-sync` (ticket-driven) |
| `Full customer cancellation` | `full-cancellation-sync` (ticket-driven) |
| `Referral discount` | `discount-sync` (deal-driven, bypasses ticketing) |
| `Retention discount` | `discount-sync` (deal-driven, bypasses ticketing) |

## Known data issue

Some companies have more than one Active Subscription deal. Real company names and deal

`discount-sync` skips these with a warning rather than writing to an arbitrary one.
The older scripts use `.find()` and will silently take the first match, so a duplicate
means the wrong deal may be updated. Worth cleaning up the duplicates.
