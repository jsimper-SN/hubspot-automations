# HubSpot Automations

GitHub Actions–powered HubSpot sync scripts replacing the previous Pipedream workflows.

## Workflows

| Workflow | Schedule | What it does |
|---|---|---|
| `expansion-sync` | Every hour (on the hour) | Finds Expansion Closed Won deals not yet synced → adds amount + products to the company's Active Subscription deal |
| `cancellation-sync` | Every hour (at :30) | Finds partial cancellation tickets (Closed-Churn / Closed-Unsavable) not yet synced → removes amount + products from the company's Active Subscription deal |

## How processed state is tracked

Both scripts use a HubSpot property to mark records as processed rather than an external state file:

- **Expansion deals** → `expansion_synced` (boolean, on Deals)
- **Cancellation tickets** → `cancellation_synced` (boolean, on Tickets)

A deal/ticket is only processed once. If a run fails mid-way, unprocessed records are retried on the next hourly run.

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
```

## HubSpot config

- Subscriptions pipeline: `3773293783`
- Active Subscription stage: `5277843668`
- Expansion pipeline: `3729013995`
- Expansion Closed Won stage: `5215212757`
- Cancellation ticket pipeline: `3789971681`
- Closed-Churn stage: `5308124360`
- Closed-Unsavable stage: `5384911081`
