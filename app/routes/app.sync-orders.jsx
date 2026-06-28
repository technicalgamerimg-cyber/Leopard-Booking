import { authenticate } from "../shopify.server";
import { ensureStore } from "../services/store.server";
import db from "../db.server";
import { codFromFinancialStatus } from "../lib/cod.server";

const PAGE_SIZE = 250;
const CLOSED_ORDERS_DAYS = 90;

const SYNC_ORDERS_QUERY = `#graphql
  query SyncOrders($cursor: String, $query: String) {
    orders(first: ${PAGE_SIZE}, after: $cursor, sortKey: ID, query: $query) {
      nodes {
        id
        name
        displayFinancialStatus
        note
        phone
        email
        totalPriceSet        { shopMoney { amount } }
        currentTotalPriceSet { shopMoney { amount } }
        lineItems(first: 1)  { edges { node { id } } }
        customer { displayName phone email }
        shippingAddress { name phone address1 address2 city province zip }
        createdAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

// Only GET is supported for this loader — the action handles the sync trigger.
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStore(session);
  return {
    lastOrderSyncCursor: store.lastOrderSyncCursor ?? null,
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const store    = await ensureStore(session);
  const formData = await request.formData();
  const cursor   = formData.get("cursor") || null; // null = start from beginning

  const ninetyDaysAgo = new Date(Date.now() - CLOSED_ORDERS_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0]; // YYYY-MM-DD

  const shopifyQuery = `status:open OR (updated_at:>${ninetyDaysAgo})`;

  let response;
  try {
    response = await admin.graphql(SYNC_ORDERS_QUERY, {
      variables: { cursor, query: shopifyQuery },
    });
  } catch (err) {
    return { ok: false, message: `Shopify API error: ${err.message}` };
  }

  const json = await response.json();
  if (json.errors) {
    return { ok: false, message: json.errors.map((e) => e.message).join("; ") };
  }

  const nodes    = json.data?.orders?.nodes ?? [];
  const pageInfo = json.data?.orders?.pageInfo ?? { hasNextPage: false, endCursor: null };

  let synced  = 0;
  let skipped = 0;

  for (const order of nodes) {
    const shipping        = order.shippingAddress ?? {};
    const financialStatus = (order.displayFinancialStatus ?? "PENDING").toUpperCase();
    const rawAmount       = parseFloat(
      order.currentTotalPriceSet?.shopMoney?.amount ??
      order.totalPriceSet?.shopMoney?.amount ??
      "0"
    );
    const totalPrice      = Math.round(Number.isFinite(rawAmount) ? rawAmount : 0);
    const codAmount       = codFromFinancialStatus(financialStatus, totalPrice);
    const consigneeName   = shipping.name ?? order.customer?.displayName ?? "Unknown";
    const consigneePhone  = shipping.phone ?? order.customer?.phone ?? order.phone ?? "";
    const consigneeAddress = [
      shipping.address1, shipping.address2,
      shipping.city, shipping.province, shipping.zip,
    ].filter(Boolean).join(", ");

    try {
      // Only update Shopify-sourced fields on PENDING shipments.
      // If already BOOKED or beyond, leave the booking state untouched.
      const existing = await db.shipment.findUnique({
        where: { storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId: order.id } },
        select: { id: true, status: true },
      });

      if (!existing) {
        await db.shipment.create({
          data: {
            storeId:          store.id,
            shopifyOrderId:   order.id,
            shopifyOrderName: order.name,
            shopifyCreatedAt: new Date(order.createdAt),
            financialStatus,
            totalPrice,
            codAmount,
            note:             order.note ?? null,
            lineItemsCount:   order.lineItems?.edges?.length ?? 1,
            consigneeName,
            consigneePhone,
            consigneeAddress,
            weightGrams:      1000, // default; overridden per-booking
            status:           "PENDING",
          },
        });
        synced++;
      } else if (existing.status === "PENDING") {
        await db.shipment.update({
          where: { id: existing.id },
          data: {
            shopifyOrderName:  order.name,
            shopifyCreatedAt:  new Date(order.createdAt),
            financialStatus,
            totalPrice,
            codAmount,
            note:              order.note ?? null,
            lineItemsCount:    order.lineItems?.edges?.length ?? 1,
            consigneeName,
            consigneePhone,
            consigneeAddress,
          },
        });
        synced++;
      } else {
        skipped++;
      }
    } catch (err) {
      console.error("[sync-orders] upsert error for", order.id, ":", err.message);
      skipped++;
    }
  }

  // Store cursor for resuming later
  const nextCursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  await db.store.update({
    where: { id: store.id },
    data:  { lastOrderSyncCursor: nextCursor },
  }).catch((e) => console.error("[sync-orders] cursor update error:", e.message));

  return {
    ok:         true,
    synced,
    skipped,
    hasMore:    pageInfo.hasNextPage,
    nextCursor,
    message:    `Synced ${synced} orders${pageInfo.hasNextPage ? " — more pages available" : " — sync complete"}.`,
  };
};
