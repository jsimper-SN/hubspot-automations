// Cancellation Sync — Cancellation-test ticket pipeline
//
// Trigger: ticket in "Cancellation - test" pipeline reaches "Closed - Takedown completed"
//
// The HubSpot workflow that creates these tickets must copy four properties from the
// originating cancellation deal onto the ticket at creation time:
//   - cancellation_scope       (Product downgrade | Product cancellation | Full customer cancellation)
//   - cancelled_product        (products to remove, semicolon-delimited)
//   - cancelled_amount         (£ amount to subtract from the active subscription deal)
//   - downgrading_product_to   (product(s) to add — downgrade only)
//
// This script then reads those values directly from the ticket and navigates:
//   ticket → company → active subscription deal
//
// Three outcomes driven by cancellation_scope:
//   "Product downgrade"          → remove cancelled_product, add downgrading_product_to, subtract cancelled_amount
//   "Product cancellation"       → remove cancelled_product, subtract cancelled_amount
//   "Full customer cancellation" → remove cancelled_product, subtract cancelled_amount

const TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
if (!TOKEN) throw new Error("HUBSPOT_ACCESS_TOKEN env var is not set");

const CANCEL_TEST_PIPELINE = "3871606003";
const TAKEDOWN_COMPLETED   = "5508107496";
const SUB_PIPELINE         = "3773293783";
const ACTIVE_STAGE         = "5277843668";

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
          { propertyName: "hs_pipeline",         operator: "EQ",               value: CANCEL_TEST_PIPELINE },
          { propertyName: "hs_pipeline_stage",   operator: "EQ",               value: TAKEDOWN_COMPLETED },
          { propertyName: "cancellation_scope",  operator: "NEQ",              value: "Full customer cancellation" },
          { propertyName: "cancellation_synced", operator: "NOT_HAS_PROPERTY" },
        ],
      }],
      properties: [
        "subject",
        "cancellation_scope",
        "cancelled_product",
        "cancelled_amount",
        "downgrading_product_to",
      ],
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
    const p = ticket.properties;

    console.log(`\nProcessing ticket ${ticketId}: ${p.subject}`);
    console.log(`  Scope:              ${p.cancellation_scope}`);
    console.log(`  Cancelled products: ${p.cancelled_product}`);
    console.log(`  Cancelled amount:   £${p.cancelled_amount}`);
    console.log(`  Downgrading to:     ${p.downgrading_product_to || "n/a"}`);

    // Validate required fields are populated (copied from deal by HubSpot workflow)
    if (!p.cancellation_scope) {
      console.warn("  ⚠ cancellation_scope not set on ticket — skipping");
      console.warn("    → Check the HubSpot workflow copies this field from the deal onto the ticket");
      results.push({ ticketId, status: "skipped: cancellation_scope missing" });
      continue;
    }
    if (!p.cancelled_product && !p.cancelled_amount) {
      console.warn("  ⚠ Neither cancelled_product nor cancelled_amount set on ticket — skipping");
      console.warn("    → Check the HubSpot workflow copies cancelled_product and cancelled_amount from the deal");
      results.push({ ticketId, status: "skipped: no cancelled_product or cancelled_amount" });
      continue;
    }
    if (p.cancellation_scope === "Product downgrade" && !p.downgrading_product_to) {
      console.warn("  ⚠ cancellation_scope is Product downgrade but downgrading_product_to is not set — skipping");
      console.warn("    → Check the HubSpot workflow copies downgrading_product_to from the deal onto the ticket");
      results.push({ ticketId, status: "skipped: downgrading_product_to missing on downgrade ticket" });
      continue;
    }

    // Get associated company directly from ticket
    const ticketCompanyAssoc = await hs("GET", `/crm/v3/objects/tickets/${ticketId}/associations/companies`);
    const companyId = ticketCompanyAssoc.results?.[0]?.id;
    if (!companyId) {
      console.warn("  ⚠ No company associated to ticket — skipping");
      results.push({ ticketId, status: "skipped: no company on ticket" });
      continue;
    }

    // Find Active Subscription deal for that company
    const subDeal = await getActiveSubDeal(companyId);
    if (!subDeal) {
      console.warn(`  ⚠ No Active Subscription deal for company ${companyId} — skipping`);
      results.push({ ticketId, status: "skipped: no active subscription deal" });
      continue;
    }

    const subDealId       = subDeal.id;
    const currentAmount   = parseFloat(subDeal.properties.amount) || 0;
    const currentProds    = splitProducts(subDeal.properties.product);
    const cancelledList   = splitProducts(p.cancelled_product);
    const downgradingList = splitProducts(p.downgrading_product_to);
    const cancelledAmount = parseFloat(p.cancelled_amount) || 0;

    // Calculate updated products
    let newProds;
    if (p.cancellation_scope === "Product downgrade") {
      const afterRemoval = currentProds.filter(prod => !cancelledList.includes(prod));
      newProds = [...new Set([...afterRemoval, ...downgradingList])];
    } else {
      // Product cancellation or Full customer cancellation
      newProds = currentProds.filter(prod => !cancelledList.includes(prod));
    }

    const newAmount  = Math.max(0, Math.round((currentAmount - cancelledAmount) * 100) / 100);
    const newProduct = newProds.join(";");

    // Update Active Subscription deal
    await hs("PATCH", `/crm/v3/objects/deals/${subDealId}`, {
      properties: { amount: String(newAmount), product: newProduct },
    });

    // Mark ticket as synced so it isn't processed again
    await hs("PATCH", `/crm/v3/objects/tickets/${ticketId}`, {
      properties: { cancellation_synced: "true" },
    });

    console.log(`  ✓ Updated subscription deal ${subDealId}`);
    console.log(`    Amount:   £${currentAmount} → £${newAmount}`);
    console.log(`    Products: [${currentProds.join(", ")}]`);
    console.log(`          → [${newProds.join(", ")}]`);

    results.push({
      ticketId,
      subscriptionDealId: subDealId,
      scope: p.cancellation_scope,
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
