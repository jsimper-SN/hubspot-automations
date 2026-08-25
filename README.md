# HubSpot Automations

GitHub Actions–powered HubSpot sync scripts replacing the previous Pipedream workflows.

## Workflows

There is **one** workflow, `hubspot-sync`, running hourly. It executes all five sync
scripts sequentially inside a single job, in this order:

| Order | Script | What it does |
|---|---|---|
| 1 | `expansion-sync` | Finds Expansion Closed Won deals not yet synced → adds amount + products to the company's Active Subscription deal |
| 2 | `full-cancellation-sync` | Finds Takedown Completed tickets with scope `Full customer cancellation` → moves the company's Active Subscription deal to Ended Subscription |
| 3 | `cancellation-sync` | Finds partial cancellation tickets (Takedown Completed, scope not `Full customer cancellation`) not yet synced → removes amount + products from the company's Active Subscription deal |
| 4 | `failed-pay-sync` | Finds Failed pay tickets at Takedown Completed → moves the company's Active Subscription deal to Ended Subscription |
| 5 | `discount-sync` | Finds **Cancellation deals** at `Sub lost` with scope `Referral discount` or `Retention discount` → subtracts `cancelled_amount` from the company's Active Subscription deal amount |

Order matters: expansion adds to subscriptions before cancellations reduce or end them,
and discounts apply last.

A failure in one script does not stop the others - each is run independently and the job
reports failure at the end listing which script(s) failed. Each script's output is
collapsed into its own log group.

### Why one workflow and not five

These were originally five separate workflows on staggered crons (:00, :15, :30, :45, :50).
GitHub bills Actions per job and rounds each job up to a whole minute, so five hourly
workflows cost roughly:

```
5 workflows × 24 hours × 30 days = 3,600 job runs = ~3,600 minutes/month
```

The account's plan includes **2,000 minutes/month**, so the allowance was exhausted around
the 20th of the month, at which point every run failed until the billing cycle reset. Four
workflows (2,880/month) already exceeded it.

One hourly job running all five costs ~720-1,440 minutes/month, comfortably inside the
allowance. If more headroom is ever needed, change the cron to `'0 */2 * * *'` (every two
hours) to halve it again.

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

Click **Run workflow** on the `HubSpot Sync` workflow to trigger a run outside the schedule.

### 4. Keep an eye on Actions minutes

Settings → Billing → Actions. This is a private repo, so minutes are metered. If runs start
failing with no step output, the allowance has been exhausted rather than anything being
wrong with the scripts or HubSpot.

## Running locally

Running locally consumes **no** GitHub Actions minutes. Use it if the allowance is
exhausted mid-cycle, or to force an immediate catch-up instead of waiting for the hour.

All five, in the same order as the workflow (Windows PowerShell):

```powershell
$env:HUBSPOT_ACCESS_TOKEN = 'pat-eu1-your-token-here'
.\run-all.ps1
```

Or one at a time:

```bash
HUBSPOT_ACCESS_TOKEN=pat-eu1-xxx node scripts/expansion-sync.mjs
HUBSPOT_ACCESS_TOKEN=pat-eu1-xxx node scripts/cancellation-sync.mjs
HUBSPOT_ACCESS_TOKEN=pat-eu1-xxx node scripts/full-cancellation-sync.mjs
HUBSPOT_ACCESS_TOKEN=pat-eu1-xxx node scripts/failed-pay-sync.mjs
HUBSPOT_ACCESS_TOKEN=pat-eu1-xxx node scripts/discount-sync.mjs
```

Never commit the token. It belongs in the shell session and in the repo secret, nowhere else.

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
