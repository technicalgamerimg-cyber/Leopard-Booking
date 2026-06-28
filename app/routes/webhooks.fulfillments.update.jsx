import { authenticate } from "../shopify.server";
import db from "../db.server";
import { safeTransition, isTerminal } from "../lib/shipment-state-machine.server";
import { withWebhookDedup } from "../lib/webhook-dedup.server";

// Shopify fulfillment shipment_status → app ShipmentStatus
const FULFILLMENT_STATUS_MAP = {
  delivered:          "DELIVERED",
  in_transit:         "IN_TRANSIT",
  out_for_delivery:   "IN_TRANSIT",
  returned_to_sender: "RETURNED",
  failure:            "EXCEPTION",
};

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  try {
    const store = await db.store.findUnique({ where: { shopDomain: shop } });
    if (!store) return new Response("OK", { status: 200 });

    await withWebhookDedup(store.id, topic, payload, async () => {
      const fulfillment    = payload;
      const shopifyOrderId = `gid://shopify/Order/${fulfillment.order_id}`;

      const shipment = await db.shipment.findUnique({
        where: { storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId } },
      });
      if (!shipment) return;

      // Terminal statuses are IMMUTABLE — Shopify retries must never resurrect them
      if (isTerminal(shipment.status)) return;

      // Detect external fulfillment cancellation while our CN is live.
      // This happens when a merchant removes the Shopify fulfillment manually.
      // We must NOT revert to PENDING (that allows duplicate CNs).
      // Instead, flag it for merchant action via the Shipments page UI.
      if (fulfillment.status === "cancelled" && shipment.cnNumber && shipment.status === "BOOKED") {
        await db.shipment.update({
          where: { id: shipment.id },
          data:  { shopifySyncBroken: true },
        });
        await db.shipmentLog.create({
          data: {
            shipmentId: shipment.id,
            eventType:  "SHOPIFY_FULFILLMENT_CANCELLED",
            fromStatus: shipment.status,
            toStatus:   shipment.status,
            message:    "Shopify fulfillment was cancelled externally while Leopards CN is still active. Merchant action required.",
          },
        });
        return;
      }

      // Map delivery tracking statuses
      const desired = FULFILLMENT_STATUS_MAP[fulfillment.shipment_status];
      if (!desired) return;

      // safeTransition enforces state machine rules and prevents regressions
      const nextStatus = safeTransition(shipment.status, desired, `fulfillments/update ${fulfillment.id}`);
      if (nextStatus === shipment.status) return;

      await db.$transaction([
        db.shipment.update({
          where: { id: shipment.id },
          data:  {
            status:     nextStatus,
            ...(nextStatus === "DELIVERED" ? { deliveredAt: new Date() } : {}),
          },
        }),
        db.shipmentLog.create({
          data: {
            shipmentId: shipment.id,
            eventType:  "STATUS_CHANGE",
            fromStatus: shipment.status,
            toStatus:   nextStatus,
            message:    `Shopify fulfillment status: '${fulfillment.shipment_status}'`,
          },
        }),
      ]);
    });
  } catch (err) {
    console.error("[webhook] fulfillments/update error", { shop, error: err?.message });
  }

  return new Response("OK", { status: 200 });
};
