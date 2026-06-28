/**
 * Exponential-backoff retry worker for failed Shopify / Leopards sync operations.
 *
 * Trigger: POST /api/sync-retry
 * Auth:    Shopify Admin session required.
 *
 * This route is intended to be called periodically (e.g., via a scheduled job,
 * a cron from an external service, or a merchant-triggered "Fix sync issues" button).
 * It processes up to 50 failed records per call to avoid timeouts.
 */

import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";
import { LeopardApiClient } from "../integrations/leopards/client.server";
import { getSettings } from "../services/settings.server";
import { cancelFulfillmentInShopify } from "../services/shipment.server";

const BATCH_SIZE = 50;

const RETRY_DELAYS_MS = [
  15 * 60 * 1000,
  60 * 60 * 1000,
  6 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
];
const MAX_RETRIES = 5;

function nextRetryAfter(retryCount) {
  const idx   = Math.min(retryCount, RETRY_DELAYS_MS.length - 1);
  return new Date(Date.now() + RETRY_DELAYS_MS[idx]);
}

// ── Shopify fulfillment writeback helpers ──────────────────────────────────────

const FULFILLMENT_ORDERS_QUERY = `#graphql
  query FulfillmentOrdersForRetry($orderId: ID!) {
    order(id: $orderId) {
      fulfillmentOrders(first: 5) {
        nodes {
          id
          status
          supportedActions { action }
          fulfillments(first: 1) { nodes { id } }
        }
      }
    }
  }
`;

const FULFILLMENT_CREATE_MUTATION = `#graphql
  mutation FulfillmentCreate($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment { id }
      userErrors { field message }
    }
  }
`;

async function retryFulfillmentWriteback(admin, shopifyOrderId, cnNumber, slipLink) {
  try {
    const res  = await admin.graphql(FULFILLMENT_ORDERS_QUERY, { variables: { orderId: shopifyOrderId } });
    const json = await res.json();
    const fos  = json.data?.order?.fulfillmentOrders?.nodes ?? [];

    const openFo   = fos.find((fo) => fo.supportedActions?.some((a) => a.action === "CREATE_FULFILLMENT"));
    const allClosed = fos.length > 0 && fos.every((fo) => fo.status === "CLOSED");
    if (allClosed) return { ok: true };
    if (!openFo) return { ok: false, reason: "No open fulfillment order" };

    const cr  = await admin.graphql(FULFILLMENT_CREATE_MUTATION, {
      variables: {
        fulfillment: {
          lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: openFo.id }],
          trackingInfo: {
            number:  cnNumber,
            url:     slipLink || `https://leopardscourier.com/track?cn=${cnNumber}`,
            company: "Leopards Courier",
          },
          notifyCustomer: false,
        },
      },
    });
    const crJson = await cr.json();
    const errors  = crJson.data?.fulfillmentCreate?.userErrors ?? [];
    if (errors.length) return { ok: false, reason: errors.map((e) => e.message).join("; ") };
    const createdId = crJson.data?.fulfillmentCreate?.fulfillment?.id ?? null;
    return { ok: true, fulfillmentId: createdId };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ── Main action ───────────────────────────────────────────────────────────────

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const storeId = (await db.store.findUnique({ where: { shopDomain: session.shop } }))?.id;
  if (!storeId) return Response.json({ ok: false, message: "Store not found." }, { status: 404 });

  const now = new Date();

  // ── 1. Process Shopify sync failures ────────────────────────────────────────
  const shopifyFailed = await db.shipment.findMany({
    where: {
      storeId,
      shopifyDeletedAt: null,
      shopifySyncStatus: { in: ["FULFILLMENT_FAILED", "CANCEL_FAILED"] },
      shopifyRetryAfter: { lte: now },
    },
    take: BATCH_SIZE,
    orderBy: { shopifyRetryAfter: "asc" },
  });

  let shopifySyncFixed = 0;
  let shopifySyncFailed = 0;

  if (shopifyFailed.length > 0) {
    const { admin } = await unauthenticated.admin(session.shop);

    for (const s of shopifyFailed) {
      const nextCount = s.shopifyRetryCount + 1;
      const permanent = nextCount >= MAX_RETRIES;

      try {
        let result;
        if (s.shopifySyncStatus === "FULFILLMENT_FAILED") {
          result = await retryFulfillmentWriteback(admin, s.shopifyOrderId, s.cnNumber, s.slipLink);
        } else {
          // CANCEL_FAILED — re-attempt Shopify fulfillment cancel
          const { ok } = await cancelFulfillmentInShopify(admin, s.shopifyOrderId);
          result = { ok };
        }

        if (result.ok) {
          const updateData = { shopifySyncStatus: "SYNC_OK", shopifyRetryCount: 0, shopifyRetryAfter: null };
          if (result.fulfillmentId) updateData.ourFulfillmentId = result.fulfillmentId;
          await db.shipment.update({ where: { id: s.id }, data: updateData });
          await db.shipmentLog.create({
            data: {
              shipmentId: s.id,
              eventType:  "SYNC_FIXED",
              fromStatus: s.status,
              toStatus:   s.status,
              message:    `Shopify ${s.shopifySyncStatus} retry succeeded (attempt ${nextCount}).`,
            },
          }).catch(() => {});
          shopifySyncFixed++;
        } else {
          await db.shipment.update({
            where: { id: s.id },
            data: {
              shopifySyncStatus: permanent ? "FAILED_PERMANENTLY" : s.shopifySyncStatus,
              shopifyRetryCount: nextCount,
              shopifyRetryAfter: permanent ? null : nextRetryAfter(nextCount),
            },
          });
          if (permanent) {
            await db.shipmentLog.create({
              data: {
                shipmentId: s.id,
                eventType:  "SYNC_FAILED_PERMANENTLY",
                fromStatus: s.status,
                toStatus:   s.status,
                message:    `Shopify sync failed permanently after ${nextCount} attempts: ${result.reason ?? "unknown"}`,
              },
            }).catch(() => {});
          } else {
            await db.shipmentLog.create({
              data: {
                shipmentId: s.id,
                eventType:  "SYNC_RETRY",
                fromStatus: s.status,
                toStatus:   s.status,
                message:    `Shopify sync retry failed (attempt ${nextCount}): ${result.reason ?? "unknown"}`,
              },
            }).catch(() => {});
          }
          shopifySyncFailed++;
        }
      } catch (err) {
        console.error("[sync-retry] Shopify retry error for", s.shopifyOrderId, ":", err.message);
        await db.shipment.update({
          where: { id: s.id },
          data: {
            shopifySyncStatus: permanent ? "FAILED_PERMANENTLY" : s.shopifySyncStatus,
            shopifyRetryCount: nextCount,
            shopifyRetryAfter: permanent ? null : nextRetryAfter(nextCount),
          },
        }).catch(() => {});
        shopifySyncFailed++;
      }
    }
  }

  // ── 2. Process Leopards sync failures ───────────────────────────────────────
  const leopardFailed = await db.shipment.findMany({
    where: {
      storeId,
      shopifyDeletedAt: null,
      leopardSyncStatus: "CANCEL_FAILED",
      leopardRetryAfter: { lte: now },
    },
    take: BATCH_SIZE,
    orderBy: { leopardRetryAfter: "asc" },
  });

  let leopardSyncFixed  = 0;
  let leopardSyncFailed = 0;

  if (leopardFailed.length > 0) {
    const settings = await getSettings(storeId, { decrypt: true });
    if (settings.leopardApiKey && settings.leopardApiPassword) {
      const client = new LeopardApiClient({ storeId, settings });

      for (const s of leopardFailed) {
        const nextCount = s.leopardRetryCount + 1;
        const permanent = nextCount >= MAX_RETRIES;
        try {
          const result = await client.cancelBookedPackets([s.cnNumber]);
          if (result.ok) {
            await db.shipment.update({
              where: { id: s.id },
              data: { leopardSyncStatus: "SYNC_OK", leopardRetryCount: 0, leopardRetryAfter: null },
            });
            await db.shipmentLog.create({
              data: {
                shipmentId: s.id,
                eventType:  "SYNC_FIXED",
                fromStatus: s.status,
                toStatus:   s.status,
                message:    `Leopards cancel retry succeeded (attempt ${nextCount}).`,
              },
            }).catch(() => {});
            leopardSyncFixed++;
          } else {
            await db.shipment.update({
              where: { id: s.id },
              data: {
                leopardSyncStatus: permanent ? "FAILED_PERMANENTLY" : "CANCEL_FAILED",
                leopardRetryCount: nextCount,
                leopardRetryAfter: permanent ? null : nextRetryAfter(nextCount),
              },
            });
            leopardSyncFailed++;
          }
        } catch (err) {
          console.error("[sync-retry] Leopards retry error for CN", s.cnNumber, ":", err.message);
          leopardSyncFailed++;
        }
      }
    }
  }

  return Response.json({
    ok: true,
    message: `Sync retry complete: Shopify fixed=${shopifySyncFixed} failed=${shopifySyncFailed}; Leopards fixed=${leopardSyncFixed} failed=${leopardSyncFailed}`,
    shopifySyncFixed,
    shopifySyncFailed,
    leopardSyncFixed,
    leopardSyncFailed,
  });
};
