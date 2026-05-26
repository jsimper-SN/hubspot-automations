// Cancellation Sync
// Finds partial cancellation tickets (Closed-Churn or Closed-Unsavable) not yet synced,
// removes their cancelled products/amount from the associated Active Subscription deal,
// then marks them synced.

const TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
if (!TOKEN) throw new Error("HUBSPOT_ACCESS_TOKEN env var is not set");

const CANCEL_PIPELINE = "3789971681";
const CLOSED_CHURN = "5308124360";
const CLOSED_UNSAVABLE = "5384911081";
const SUB_PIPELINE = "3773293783";
const ACTIVE_STAGE = "5277843668";

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

async function fetchUnprocessedTickets() {
  const tickets = [];
  let after;
  while (true) {
    const body = {
      filterGroups: [
        {
          filters: [
            { propertyName: "hs_pipeline", operator: "EQ", value: CANCEL_PIPELINE },
            { propertyName: "hs_pipeline_stage", operator: "EQ", value: CLOSED_CHURN },
            { propertyName: "cancellation_scope", operator: "EQ", value: "partial_cancellation" },
            { propertyName: "cancellation_synced", operator: "NOT_HAS_PROPERTY" },
          ]
        },
        {
          filters: [
            { propertyName: "hs_pipeline", operator: "EQ", value: CANCEL_PIPELINE },
            { propertyName: "hs_pipeline_stage", operator: "EQ", value: CLOSED_UNSAVABLE },
            { propertyName: "cancellation_scope", operator: "EQ", value: "partial_cancellation" },
            { propertyName: "cancellation_synced", operator: "NOT_HAS_PROPERTY" },
          ]
        },
      ],
      properties: ["subject", "hs_pipeline_stage", "cancellation_scope", "cancelled_product", "cancelled_amount"],
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

async function main() {
  console.log("Fetching unprocessed partial cancellation tickets...");
  const tickets = await fetchUnprocessedTickets();
  console.log(`Found ${tickets.length} unprocessed ticket(s)`);

  if (tickets.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const results = [];

  for (const ticket of tickets) {
    const ticketId = ticket.id;
    const cancelledProduct = ticket.properties.cancelled_product || "";
    const cancelledAmount = parseFloat(ticket.properties.cancelled_amount) || 0;

    if (!cancelledProduct && cancelledAmount === 0) {
      console.warn(`  ⚠ Ticket ${ticketId} has no cancelled_product or cancelled_amount — skipping`);
      results.push({ ticketId, status: "skipped: no cancelled values set" });
      continue;
    }

    console.log(`Processing ticket ${ticketId} — removing £${cancelledAmount}, products: "${cancelledProduct}"`);

    // Get associated company
    const assocRes = await hs("GET", `/crm/v3/objects/tickets/${ticketId}/associations/companies`);
    const companyId = assocRes.results?.[0]?.id;
    if (!companyId) {
      console.warn(`  ⚠ No company associated — skipping`);
      results.push({ ticketId, status: "skipped: no company" });
      continue;
    }

    // Get all deals for that company
    const companyDeals = await hs("GET", `/crm/v3/objects/companies/${companyId}/associations/deals`);
    const dealIds = companyDeals.results.map(r => r.id);

    if (dealIds.length === 0) {
      console.warn(`  ⚠ No deals for company ${companyId} — skipping`);
      results.push({ ticketId, status: "skipped: no deals" });
      continue;
    }

    // Find the Active Subscription deal
    const batchRes = await hs("POST", "/crm/v3/objects/deals/batch/read", {
      inputs: dealIds.map(id => ({ id })),
      properties: ["dealname", "pipeline", "dealstage", "amount", "product"],
    });

    const subDeal = batchRes.results.find(
      d => d.properties.pipeline === SUB_PIPELINE && d.properties.dealstage === ACTIVE_STAGE
    );

    if (!subDeal) {
      console.warn(`  ⚠ No Active Subscription deal for company ${companyId} — skipping`);
      results.push({ ticketId, status: "skipped: no active subscription deal" });
      continue;
    }

    const subDealId = subDeal.id;
    const currentAmount = parseFloat(subDeal.properties.amount) || 0;
    const currentProduct = subDeal.properties.product || "";
    const newAmount = Math.max(0, Math.round((currentAmount - cancelledAmount) * 100) / 100);

    const cancelledList = cancelledProduct.split(";").map(p => p.trim()).filter(Boolean);
    const remaining = currentProduct.split(";").map(p => p.trim()).filter(Boolean)
      .filter(p => !cancelledList.includes(p));
    const newProduct = remaining.join(";");

    // Update subscription deal
    await hs("PATCH", `/crm/v3/objects/deals/${subDealId}`, {
      properties: { amount: String(newAmount), product: newProduct },
    });

    // Mark ticket as synced
    await hs("PATCH", `/crm/v3/objects/tickets/${ticketId}`, {
      properties: { cancellation_synced: "true" },
    });

    console.log(`  ✓ Updated subscription deal ${subDealId}: £${currentAmount} → £${newAmount}`);
    results.push({
      ticketId,
      subscriptionDealId: subDealId,
      previousAmount: currentAmount,
      newAmount,
      previousProduct: currentProduct,
      newProduct,
      cancelledProduct,
      status: "updated",
    });
  }

  console.log("\n=== Summary ===");
  const updated = results.filter(r => r.status === "updated").length;
  const skipped = results.filter(r => r.status?.startsWith("skipped")).length;
  console.log(`Updated: ${updated}, Skipped: ${skipped}`);
  console.log(JSON.stringify(results, null, 2));
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
