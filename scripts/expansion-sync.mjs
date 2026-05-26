// Expansion to Subscription Sync
// Finds Expansion Closed Won deals not yet synced, adds their amount + products
// to the associated company's Active Subscription deal, then marks them synced.

const TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
if (!TOKEN) throw new Error("HUBSPOT_ACCESS_TOKEN env var is not set");

const EXPANSION_PIPELINE = "3729013995";
const EXPANSION_CLOSED_WON = "5215212757";
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

async function fetchUnprocessedExpansionDeals() {
  const deals = [];
  let after;
  while (true) {
    const body = {
      filterGroups: [{
        filters: [
          { propertyName: "pipeline", operator: "EQ", value: EXPANSION_PIPELINE },
          { propertyName: "dealstage", operator: "EQ", value: EXPANSION_CLOSED_WON },
          { propertyName: "expansion_synced", operator: "NOT_HAS_PROPERTY" },
        ]
      }],
      properties: ["dealname", "amount", "product", "pipeline", "dealstage"],
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

async function main() {
  console.log("Fetching unprocessed Expansion Closed Won deals...");
  const deals = await fetchUnprocessedExpansionDeals();
  console.log(`Found ${deals.length} unprocessed deal(s)`);

  if (deals.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const results = [];

  for (const deal of deals) {
    const dealId = deal.id;
    const expansionAmount = parseFloat(deal.properties.amount) || 0;
    const expansionProduct = deal.properties.product || "";

    console.log(`Processing deal ${dealId}: ${deal.properties.dealname} (£${expansionAmount})`);

    // Get associated company
    const assocRes = await hs("GET", `/crm/v3/objects/deals/${dealId}/associations/companies`);
    const companyId = assocRes.results?.[0]?.id;
    if (!companyId) {
      console.warn(`  ⚠ No company associated — skipping`);
      results.push({ dealId, status: "skipped: no company" });
      continue;
    }

    // Get all deals for that company
    const companyDeals = await hs("GET", `/crm/v3/objects/companies/${companyId}/associations/deals`);
    const otherDealIds = companyDeals.results.map(r => r.id).filter(id => id !== dealId);

    if (otherDealIds.length === 0) {
      console.warn(`  ⚠ No other deals for company ${companyId} — skipping`);
      results.push({ dealId, status: "skipped: no other deals" });
      continue;
    }

    // Find the Active Subscription deal
    const batchRes = await hs("POST", "/crm/v3/objects/deals/batch/read", {
      inputs: otherDealIds.map(id => ({ id })),
      properties: ["dealname", "pipeline", "dealstage", "amount", "product"],
    });

    const subDeal = batchRes.results.find(
      d => d.properties.pipeline === SUB_PIPELINE && d.properties.dealstage === ACTIVE_STAGE
    );

    if (!subDeal) {
      console.warn(`  ⚠ No Active Subscription deal found for company ${companyId} — skipping`);
      results.push({ dealId, status: "skipped: no active subscription deal" });
      continue;
    }

    const subDealId = subDeal.id;
    const currentAmount = parseFloat(subDeal.properties.amount) || 0;
    const currentProduct = subDeal.properties.product || "";
    const newAmount = Math.round((currentAmount + expansionAmount) * 100) / 100;

    const existingProducts = currentProduct.split(";").map(p => p.trim()).filter(Boolean);
    const newProducts = expansionProduct.split(";").map(p => p.trim()).filter(Boolean);
    const mergedProduct = [...new Set([...existingProducts, ...newProducts])].join(";");

    // Update subscription deal
    await hs("PATCH", `/crm/v3/objects/deals/${subDealId}`, {
      properties: { amount: String(newAmount), product: mergedProduct },
    });

    // Mark expansion deal as synced
    await hs("PATCH", `/crm/v3/objects/deals/${dealId}`, {
      properties: { expansion_synced: "true" },
    });

    console.log(`  ✓ Updated subscription deal ${subDealId}: £${currentAmount} → £${newAmount}`);
    results.push({
      expansionDealId: dealId,
      subscriptionDealId: subDealId,
      previousAmount: currentAmount,
      newAmount,
      previousProduct: currentProduct,
      newProduct: mergedProduct,
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
