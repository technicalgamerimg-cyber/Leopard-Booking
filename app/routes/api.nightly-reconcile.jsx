/**
 * Nightly reconciliation job — comprehensive audit of all active shipments.
 *
 * Trigger: POST /api/nightly-reconcile
 * Auth:    Shopify Admin session required (or internal secret header).
 *
 * What it does:
 * 1. Leopards status sweep — update BOOKED/IN_TRANSIT shipments from Leopards API
 * 2. Shopify state comparison — detect cancellations, deletions, status mismatches
 * 3. Surface FAILED_PERMANENTLY records as alerts
 * 4. Alert on shopifySyncBroken records with no resolution for > 24h
 */

import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";
import { LeopardApiClient } from "../integrations/leopards/client.server";
import { getSettings } from "../services/settings.server";
import { mapLeopardStatus } from "../integrations/leopards/status-map.server";
import { isTerminal, safeTransition } from "../lib/shipment-state-machine.server";

const CHUNK_SIZE = 20;
const CONCURRENCY = 3;

function extractTrackedPackets(result) {
  const source =
    result?.data?.packet_list ??
    result?.raw?.packet_list ??
    result?.data ??
    [];
  return Array.isArray(source) ? source : [];
}

const ORDER_STATUS_QUERY = `#graphql
  query OrderStatusForReconcile($id: ID!) {
    order(id: $id) {
      displayFinancialStatus
      cancelledAt
      fulfillmentOrders(first: 5) {
        nodes {
          id
          status
          fulfillments(first: 1) {
            nodes { id status trackingInfo { number } }
          }
        }
      }
    }
  }
`;

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await db.store.findUnique({ where: { shopDomain: session.shop } });
  if (!store) return Response.json({ ok: false, message: "Store not found." }, { status: 404 });

  const settings = await getSettings(store.id, { decrypt: true });
  const storeId  = store.id;
  const report   = {
    leopardsUpdated:   0,
    leopardsFailed:    0,
    shopifyMismatches: 0,
    permanentFailures: 0,
    brokenAlerts:      0,
    errors:            [],
  };

  // ── 1. Leopards status sweep ─────────────────────────────────────────────────
  if (settings.leopardApiKey && settings.leopardApiPassword) {
    const activeShipments = await db.shipment.findMany({
      where: {
        storeId,
        shopifyDeletedAt: null,
        cnNumber: { not: null },
        status:   { in: ["BOOKED", "IN_TRANSIT"] },
      },
      take: 500,
    });

    if (activeShipments.length > 0) {
      const client  = new LeopardApiClient({ storeId, settings });
      const allCns  = activeShipments.map((s) => s.cnNumber);
      const packets = [];

      const chunks = [];
      for (let i = 0; i < allCns.length; i += CHUNK_SIZE) {
        chunks.push(allCns.slice(i, i + CHUNK_SIZE));
      }

      for (let i = 0; i < chunks.length; i += CONCURRENCY) {
        const batch = await Promise.allSettled(
          chunks.slice(i, i + CONCURRENCY).map((chunk) => client.trackBookedPacket(chunk)),
        );
        for (const item of batch) {
          if (item.status === "fulfilled" && item.value.ok) {
            packets.push(...extractTrackedPackets(item.value));
          } else {
            const msg = item.status === "rejected"
              ? item.reason?.message
              : item.value?.message;
            report.leopardsFailed++;
            report.errors.push(`Leopards API chunk error: ${msg ?? "unknown"}`);
          }
        }
      }

      const byCn = new Map(
        packets.map((p) => [
          String(p.track_number ?? p.tracking_number ?? p.cn_number ?? p.CN ?? ""),
          p,
        ]),
      );

      for (const shipment of activeShipments) {
        if (isTerminal(shipment.status)) continue;
        const packet = byCn.get(String(shipment.cnNumber));
        if (!packet) continue;

        const rawStatus = packet.booked_packet_status ?? packet.status ?? packet.packet_status;
        if (!rawStatus) continue;

        const rawStr    = String(rawStatus);
        const desired   = mapLeopardStatus(rawStr);
        const nextStatus = safeTransition(shipment.status, desired, `CN ${shipment.cnNumber}`);

        if (nextStatus !== shipment.status) {
          try {
            await db.$transaction([
              db.shipment.update({
                where: { id: shipment.id },
                data: {
                  status:           nextStatus,
                  leopardStatusRaw: rawStr,
                  ...(nextStatus === "DELIVERED" ? { deliveredAt: new Date() } : {}),
                  ...(nextStatus === "CANCELLED" ? { cancelledAt: new Date() } : {}),
                },
              }),
              db.shipmentLog.create({
                data: {
                  shipmentId: shipment.id,
                  eventType:  "STATUS_CHANGE",
                  fromStatus: shipment.status,
                  toStatus:   nextStatus,
                  message:    `Nightly reconcile: Leopards status '${rawStr}'`,
                },
              }),
            ]);
            report.leopardsUpdated++;
          } catch (err) {
            report.errors.push(`Status update for CN ${shipment.cnNumber}: ${err.message}`);
          }
        }
      }
    }
  }

  // ── 2. Shopify state comparison ─────────────────────────────────────────────
  // Check BOOKED shipments that haven't been confirmed in Shopify yet.
  const bookedShipments = await db.shipment.findMany({
    where: {
      storeId,
      shopifyDeletedAt: null,
      status:           "BOOKED",
      shopifySyncStatus: "SYNC_OK",
      cnNumber:         { not: null },
    },
    take: 100,
    orderBy: { bookedAt: "asc" },
  });

  if (bookedShipments.length > 0) {
    const { admin } = await unauthenticated.admin(session.shop);

    for (const s of bookedShipments) {
      try {
        const res  = await admin.graphql(ORDER_STATUS_QUERY, { variables: { id: s.shopifyOrderId } });
        const json = await res.json();
        const order = json.data?.order;
        if (!order) {
          // Order gone from Shopify — soft-delete
          await db.shipment.update({
            where: { id: s.id },
            data:  { shopifyDeletedAt: new Date() },
          });
          continue;
        }

        // If the order was cancelled in Shopify but we still have it BOOKED
        if (order.cancelledAt) {
          await db.shipment.update({
            where: { id: s.id },
            data:  { status: "CANCELLED", cancelledAt: new Date(), shopifySyncStatus: "SYNC_OK" },
          });
          await db.shipmentLog.create({
            data: {
              shipmentId: s.id,
              eventType:  "CANCELLED",
              fromStatus: "BOOKED",
              toStatus:   "CANCELLED",
              message:    "Nightly reconcile: order was cancelled in Shopify.",
            },
          }).catch(() => {});
          report.shopifyMismatches++;
          continue;
        }

        // Check if our fulfillment is still there
        const allFos          = order.fulfillmentOrders?.nodes ?? [];
        const ourFulfillment  = allFos.flatMap((fo) => fo.fulfillments?.nodes ?? []).find(
          (f) => f.trackingInfo?.some?.((t) => t.number === s.cnNumber),
        );

        if (!ourFulfillment && allFos.some((fo) => fo.status === "CLOSED")) {
          // Fulfillment closed but ours is missing — could be external or removed
          if (!s.shopifySyncBroken) {
            await db.shipment.update({
              where: { id: s.id },
              data:  { shopifySyncBroken: true },
            });
            await db.shipmentLog.create({
              data: {
                shipmentId: s.id,
                eventType:  "SHOPIFY_FULFILLMENT_CANCELLED",
                fromStatus: "BOOKED",
                toStatus:   "BOOKED",
                message:    "Nightly reconcile: Shopify fulfillment closed but our CN not found; shopifySyncBroken=true.",
              },
            }).catch(() => {});
            report.shopifyMismatches++;
          }
        }
      } catch (err) {
        report.errors.push(`Shopify check for ${s.shopifyOrderId}: ${err.message}`);
      }
    }
  }

  // ── 3. Surface FAILED_PERMANENTLY records ────────────────────────────────────
  const permanentlyFailed = await db.shipment.count({
    where: {
      storeId,
      shopifyDeletedAt: null,
      OR: [
        { shopifySyncStatus: "FAILED_PERMANENTLY" },
        { leopardSyncStatus: "FAILED_PERMANENTLY" },
      ],
    },
  });
  report.permanentFailures = permanentlyFailed;

  // ── 4. shopifySyncBroken alerts with no resolution for > 24h ─────────────────
  const brokenCutoff  = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const staleBroken   = await db.shipment.count({
    where: {
      storeId,
      shopifyDeletedAt: null,
      shopifySyncBroken: true,
      updatedAt: { lt: brokenCutoff },
    },
  });
  report.brokenAlerts = staleBroken;

  if (staleBroken > 0) {
    console.warn(`[nightly-reconcile] ${staleBroken} shipment(s) have shopifySyncBroken=true for >24h — merchant action required.`);
  }

  console.log("[nightly-reconcile] complete", JSON.stringify(report));

  return Response.json({
    ok: true,
    ...report,
    message: `Reconciliation complete. Leopards updated: ${report.leopardsUpdated}, Shopify mismatches: ${report.shopifyMismatches}, Permanent failures: ${report.permanentFailures}, Stale broken: ${report.brokenAlerts}`,
  });
};
