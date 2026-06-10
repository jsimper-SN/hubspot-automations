// Full Customer Cancellation Sync
//
// Trigger: ticket in "Cancellation - test" pipeline reaches "Closed - Takedown completed"
//          AND cancellation_scope = "Full customer cancellation"
//
// Action: find the company's Active Subscription deal and move it to Ended Subscription.
// No amount or product changes — just the stage move.
//
// Association chain: ticket → company → active subscription deal
// (no deal association required)

const TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
if (!TOKEN) throw new Error("HUBSPOT_ACCESS_TOKEN env var is not set");

const CANCEL_TEST_PIPELINE = "3871606003";
const TAKEDOWN_COMPLETED   = "5508107496";
const SUB_PIPELINE         = "3773293783";
const ACTIVE_STAGE         = "5277843668";
const ENDED_STAGE          = "5277843669";

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
      filterGroups: [{
        filters: [
          { propertyName: "hs_pipeline",         operator: "EQ",               value: CANCEL_TEST_PIPELINE },
          { propertyName: "hs_pipeline_stage",   operator: "EQ",               value: TAKEDOWN_COMPLETED },
          { propertyName: "cancellation_scope",  operator: "EQ",               value: "Full customer cancellation" },
          { propertyName: "cancellation_synced", operator: "NOT_HAS_PROPERTY" },
        ],
      }],
      properties: ["subject", "cancellation_scope"],
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
  console.log("Fetching unprocessed Full Customer Cancellation tickets...");
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

    // Get associated company from ticket
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

    // Move deal from Active → Ended
    await hs("PATCH", `/crm/v3/objects/deals/${subDeal.id}`, {
      properties: { dealstage: ENDED_STAGE },
    });

    // Mark ticket as synced
    await hs("PATCH", `/crm/v3/objects/tickets/${ticketId}`, {
      properties: { cancellation_synced: "true" },
    });

    console.log(`  ✓ Subscription deal ${subDeal.id} (${subDeal.properties.dealname}) moved to Ended`);
    results.push({
      ticketId,
      subscriptionDealId: subDeal.id,
      dealName: subDeal.properties.dealname,
      status: "moved to ended",
    });
  }

  console.log("\n=== Summary ===");
  console.log(`Moved to Ended: ${results.filter(r => r.status === "moved to ended").length}`);
  console.log(`Skipped:        ${results.filter(r => r.status?.startsWith("skipped")).length}`);
  console.log(JSON.stringify(results, null, 2));
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
