// Discount Sync — Referral discount & Retention discount
//
// Trigger: deal in the "Cancellation" DEAL pipeline reaches "Sub lost"
//          AND cancellation_scope is "Referral discount" or "Retention discount"
//
// Action:  subtract cancelled_amount from the company's Active Subscription deal amount.
//
// This is the only sync driven by a DEAL rather than a ticket. Referral and retention
// discounts bypass the ticketing side of the cancellation process — no takedown work is
// required, so no ticket is raised and the deal never reaches "Closed - Notice period
// running". The other three cancellation_scope values continue to flow through
// cancellation-sync / full-cancellation-sync off the Cancellation-test ticket pipeline.
//
// Products are deliberately left untouched. A discount reduces what the customer pays
// for the same subscription; nothing is being removed from it.
//
// Association chain: cancellation deal → company → active subscription deal
//
// IMPORTANT: the HubSpot workflow that raises cancellation tickets must exclude these two
// scope values. If a ticket is also raised for a referral/retention deal, cancellation-sync
// would subtract the same amount a second time — the two scripts track processed state on
// different objects (discount_synced on the deal vs cancellation_synced on the ticket) and
// cannot see each other's work.

const TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
if (!TOKEN) throw new Error("HUBSPOT_ACCESS_TOKEN env var is not set");

const CANCELLATION_PIPELINE = "3871606001";
const SUB_LOST_STAGE        = "5872711925";
const SUB_PIPELINE          = "3773293783";
const ACTIVE_STAGE          = "5277843668";

const DISCOUNT_SCOPES = ["Referral discount", "Retention discount"];

async function hs(method, path, body) {
  const res = await fetch(`https://api.hubapi.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot ${method} ${path} → ${res.status}: ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function fetchUnprocessedDeals() {
  const deals = [];
  let after;
  while (true) {
    const body = {
      filterGroups: [{
        filters: [
          { propertyName: "pipeline",            operator: "EQ",               value: CANCELLATION_PIPELINE },
          { propertyName: "dealstage",           operator: "EQ",               value: SUB_LOST_STAGE },
          { propertyName: "cancellation_scope",  operator: "IN",               values: DISCOUNT_SCOPES },
          { propertyName: "discount_synced",     operator: "NOT_HAS_PROPERTY" },
        ],
      }],
      properties: [
        "dealname",
        "cancellation_scope",
        "cancelled_amount",
      ],
      limit: 100,
      ...(after ? { after } : {}),
    };
    const data = await hs("POST", "/crm/v3/objects/deals/search", body);
    deals.push(...data.results);
    after = data.paging?.next?.after;
    if (!after) break;
  }
  return deals;
}

// Returns ALL active subscription deals for the company, not just the first.
// At least one company in this portal carries two identical Active Subscription deals,
// so picking the first match would silently write to the wrong record.
async function getActiveSubDeals(companyId) {
  const companyDeals = await hs("GET", `/crm/v3/objects/companies/${companyId}/associations/deals`);
  const dealIds = companyDeals.results?.map(r => r.id) ?? [];
  if (dealIds.length === 0) return [];

  const batch = await hs("POST", "/crm/v3/objects/deals/batch/read", {
    inputs: dealIds.map(id => ({ id })),
    properties: ["dealname", "pipeline", "dealstage", "amount"],
  });

  return batch.results.filter(
    d => d.properties.pipeline === SUB_PIPELINE && d.properties.dealstage === ACTIVE_STAGE
  );
}

async function main() {
  console.log("Fetching unprocessed Sub lost discount deals...");
  const deals = await fetchUnprocessedDeals();
  console.log(`Found ${deals.length} unprocessed deal(s)`);

  if (deals.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const results = [];

  for (const deal of deals) {
    const dealId = deal.id;
    const p = deal.properties;

    console.log(`\nProcessing deal ${dealId}: ${p.dealname}`);
    console.log(`  Scope:            ${p.cancellation_scope}`);
    console.log(`  Cancelled amount: £${p.cancelled_amount}`);

    const cancelledAmount = parseFloat(p.cancelled_amount);
    if (!Number.isFinite(cancelledAmount) || cancelledAmount <= 0) {
      console.warn("  ⚠ cancelled_amount missing or not a positive number — skipping");
      console.warn("    → Set the £ discount amount on the cancellation deal, then it will sync next run");
      results.push({ dealId, status: "skipped: cancelled_amount missing or invalid" });
      continue;
    }

    // Get associated company directly from the cancellation deal
    const dealCompanyAssoc = await hs("GET", `/crm/v3/objects/deals/${dealId}/associations/companies`);
    const companyId = dealCompanyAssoc.results?.[0]?.id;
    if (!companyId) {
      console.warn("  ⚠ No company associated to deal — skipping");
      results.push({ dealId, status: "skipped: no company on deal" });
      continue;
    }

    const subDeals = await getActiveSubDeals(companyId);

    if (subDeals.length === 0) {
      console.warn(`  ⚠ No Active Subscription deal for company ${companyId} — skipping`);
      results.push({ dealId, status: "skipped: no active subscription deal" });
      continue;
    }

    // Refuse to guess rather than corrupt a revenue figure.
    if (subDeals.length > 1) {
      console.warn(`  ⚠ Company ${companyId} has ${subDeals.length} Active Subscription deals — skipping`);
      console.warn(`    → Duplicates: ${subDeals.map(d => `${d.id} (£${d.properties.amount})`).join(", ")}`);
      console.warn("    → Merge or end the duplicate, then this will sync on the next run");
      results.push({
        dealId,
        status: "skipped: multiple active subscription deals",
        candidates: subDeals.map(d => d.id).join(","),
      });
      continue;
    }

    const subDeal       = subDeals[0];
    const subDealId     = subDeal.id;
    const currentAmount = parseFloat(subDeal.properties.amount) || 0;

    // A discount larger than the subscription itself means the data is wrong. Unlike a
    // cancellation, there is no legitimate case for flooring this to zero.
    if (cancelledAmount > currentAmount) {
      console.warn(`  ⚠ Discount £${cancelledAmount} exceeds subscription amount £${currentAmount} — skipping`);
      console.warn("    → Check cancelled_amount on the cancellation deal");
      results.push({
        dealId,
        subscriptionDealId: subDealId,
        status: "skipped: discount exceeds subscription amount",
      });
      continue;
    }

    const newAmount = Math.round((currentAmount - cancelledAmount) * 100) / 100;

    // Update Active Subscription deal — amount only, products unchanged
    await hs("PATCH", `/crm/v3/objects/deals/${subDealId}`, {
      properties: { amount: String(newAmount) },
    });

    // Mark cancellation deal as synced so it isn't processed again
    await hs("PATCH", `/crm/v3/objects/deals/${dealId}`, {
      properties: { discount_synced: "true" },
    });

    console.log(`  ✓ Updated subscription deal ${subDealId} (${subDeal.properties.dealname})`);
    console.log(`    Amount: £${currentAmount} → £${newAmount}`);

    results.push({
      dealId,
      subscriptionDealId: subDealId,
      scope: p.cancellation_scope,
      previousAmount: currentAmount,
      newAmount,
      status: "updated",
    });
  }

  console.log("\n=== Summary ===");
  console.log(`Updated: ${results.filter(r => r.status === "updated").length}`);
  console.log(`Skipped: ${results.filter(r => r.status?.startsWith("skipped")).length}`);
  console.log(JSON.stringify(results, null, 2));
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
