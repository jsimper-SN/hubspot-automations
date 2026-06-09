// Cancellation Sync — Cancellation-test ticket pipeline
//
// Trigger: ticket in "Cancellation - test" pipeline reaches "Closed - Takedown completed"
// Source of truth: the cancellation DEAL associated to the ticket
//
// Three outcomes, driven by cancellation_scope on the deal:
//   "Product downgrade"          → remove cancelled_products, add downgrading_to_product, subtract cancelled_amount
//   "Product cancellation"       → remove cancelled_products, subtract cancelled_amount
//   "Full customer cancellation" → remove cancelled_products, subtract cancelled_amount

const TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
if (!TOKEN) throw new Error("HUBSPOT_ACCESS_TOKEN env var is not set");

const CANCEL_TEST_PIPELINE   = "3871606003";
const TAKEDOWN_COMPLETED     = "5508107496";
const SUB_PIPELINE           = "3773293783";
const ACTIVE_STAGE           = "5277843668";

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

function splitProducts(str) {
  return (str || "").split(";").map(p => p.trim()).filter(Boolean);
}

async function fetchUnprocessedTickets() {
  const tickets = [];
  let after;
  while (true) {
    const body = {
      filterGroups: [{
        filters: [
          { propertyName: "hs_pipeline",       operator: "EQ",               value: CANCEL_TEST_PIPELINE },
          { propertyName: "hs_pipeline_stage", operator: "EQ",               value: TAKEDOWN_COMPLETED },
          { propertyName: "cancellation_synced", operator: "NOT_HAS_PROPERTY" },
        ],
      }],
      properties: ["subject", "hs_pipeline_stage", "cancellation_synced"],
      limit: 100,
      ...(after ? { after } : {}),
    };
    const data = await hs("POST", "/crm/v3/objects/tickets/search", body);
    tickets.push(...data.results);
    after = data.paging?.next?.after;
    if (!after) break;
  }
  return tickets;
}

async function getCancellationDeal(ticketId) {
  // Try direct ticket → deal association first
  const assoc = await hs("GET", `/crm/v3/objects/tickets/${ticketId}/associations/deals`);
  const dealIds = assoc.results?.map(r => r.id) ?? [];

  if (dealIds.length === 0) return null;

  // Batch-read to find the one in the Cancellation deal pipeline
  const batch = await hs("POST", "/crm/v3/objects/deals/batch/read", {
    inputs: dealIds.map(id => ({ id })),
    properties: ["dealname", "pipeline", "dealstage", "cancellation_scope",
                 "cancelled_products", "cancelled_amount", "downgrading_to_product"],
  });

  return batch.results.find(d => d.properties.pipeline === "3871606001") ?? null;
}

async function getActiveSubDeal(companyId) {
  const companyDeals = await hs("GET", `/crm/v3/objects/companies/${companyId}/associations/deals`);
  const dealIds = companyDeals.results?.map(r => r.id) ?? [];
  if (dealIds.length === 0) return null;

  const batch = await hs("POST", "/crm/v3/objects/deals/batch/read", {
    inputs: dealIds.map(id => ({ id })),
    properties: ["dealname", "pipeline", "dealstage", "amount", "product"],
  });

  return batch.results.find(
    d => d.properties.pipeline === SUB_PIPELINE && d.properties.dealstage === ACTIVE_STAGE
  ) ?? null;
}

async function main() {
  console.log("Fetching unprocessed Takedown Completed tickets...");
  const tickets = await fetchUnprocessedTickets();
  console.log(`Found ${tickets.length} unprocessed ticket(s)`);

  if (tickets.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const results = [];

  for (const ticket of tickets) {
    const ticketId = ticket.id;
    console.log(`\nProcessing ticket ${ticketId}: ${ticket.properties.subject}`);

    // 1. Get the cancellation deal
    const cancelDeal = await getCancellationDeal(ticketId);
    if (!cancelDeal) {
      console.warn("  ⚠ No cancellation deal found via ticket→deal association — skipping");
      results.push({ ticketId, status: "skipped: no cancellation deal found" });
      continue;
    }

    const scope           = cancelDeal.properties.cancellation_scope;
    const cancelledProds  = cancelDeal.properties.cancelled_products || "";
    const cancelledAmount = parseFloat(cancelDeal.properties.cancelled_amount) || 0;
    const downgradingTo   = cancelDeal.properties.downgrading_to_product || "";

    console.log(`  Scope: ${scope}`);
    console.log(`  Cancelled products: ${cancelledProds}`);
    console.log(`  Cancelled amount: £${cancelledAmount}`);
    if (scope === "Product downgrade") console.log(`  Downgrading to: ${downgradingTo}`);

    if (!scope) {
      console.warn("  ⚠ cancellation_scope not set on deal — skipping");
      results.push({ ticketId, status: "skipped: no cancellation_scope on deal" });
      continue;
    }

    // 2. Get company from the cancellation deal
    const dealAssoc = await hs("GET", `/crm/v3/objects/deals/${cancelDeal.id}/associations/companies`);
    const companyId = dealAssoc.results?.[0]?.id;
    if (!companyId) {
      console.warn("  ⚠ No company on cancellation deal — skipping");
      results.push({ ticketId, status: "skipped: no company on deal" });
      continue;
    }

    // 3. Find Active Subscription deal
    const subDeal = await getActiveSubDeal(companyId);
    if (!subDeal) {
      console.warn(`  ⚠ No Active Subscription deal for company ${companyId} — skipping`);
      results.push({ ticketId, status: "skipped: no active subscription deal" });
      continue;
    }

    const subDealId      = subDeal.id;
    const currentAmount  = parseFloat(subDeal.properties.amount) || 0;
    const currentProds   = splitProducts(subDeal.properties.product);
    const cancelledList  = splitProducts(cancelledProds);
    const downgradingList = splitProducts(downgradingTo);

    // 4. Calculate new products and amount
    let newProds;
    if (scope === "Product downgrade") {
      // Remove cancelled products, add downgrading_to products
      const afterRemoval = currentProds.filter(p => !cancelledList.includes(p));
      newProds = [...new Set([...afterRemoval, ...downgradingList])];
    } else {
      // Product cancellation or Full customer cancellation — just remove
      newProds = currentProds.filter(p => !cancelledList.includes(p));
    }

    const newAmount = Math.max(0, Math.round((currentAmount - cancelledAmount) * 100) / 100);
    const newProduct = newProds.join(";");

    // 5. Update the Active Subscription deal
    await hs("PATCH", `/crm/v3/objects/deals/${subDealId}`, {
      properties: { amount: String(newAmount), product: newProduct },
    });

    // 6. Mark ticket as synced
    await hs("PATCH", `/crm/v3/objects/tickets/${ticketId}`, {
      properties: { cancellation_synced: "true" },
    });

    console.log(`  ✓ Updated subscription deal ${subDealId}`);
    console.log(`    Amount: £${currentAmount} → £${newAmount}`);
    console.log(`    Products: [${currentProds.join(", ")}] → [${newProds.join(", ")}]`);

    results.push({
      ticketId,
      cancellationDealId: cancelDeal.id,
      subscriptionDealId: subDealId,
      scope,
      previousAmount: currentAmount,
      newAmount,
      previousProducts: currentProds.join(";"),
      newProducts: newProduct,
      status: "updated",
    });
  }

  console.log("\n=== Summary ===");
  console.log(`Updated: ${results.filter(r => r.status === "updated").length}`);
  console.log(`Skipped: ${results.filter(r => r.status?.startsWith("skipped")).length}`);
  console.log(JSON.stringify(results, null, 2));
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
