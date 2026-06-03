import { authenticate } from "../shopify.server";
import db from "../db.server";
import { canTransition } from "../lib/shipment-state-machine.server";
import { withWebhookDedup } from "../lib/webhook-dedup.server";

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

      // ─────────────────────────────────────────────────────────────────────
      // CRITICAL: Skip if this fulfillment was created by our own writeback.
      //
      // When we call writebackFulfillment() after booking, Shopify fires this
      // webhook. Without this guard, the shipment would be immediately advanced
      // to IN_TRANSIT seconds after booking — before Leopards has even picked
      // it up. Status must only advance via Leopards API polling.
      // ─────────────────────────────────────────────────────────────────────
      const trackingNumbers = fulfillment.tracking_numbers ?? [];
      if (trackingNumbers.includes(shipment.cnNumber)) {
        console.log(
          `[webhook] fulfillments/create: skipping own writeback for CN ${shipment.cnNumber}`,
        );
        return;
      }

      // Only advance if the state machine allows it
      if (!canTransition(shipment.status, "IN_TRANSIT")) return;

      await db.$transaction([
        db.shipment.update({
          where: { id: shipment.id },
          data:  { status: "IN_TRANSIT" },
        }),
        db.shipmentLog.create({
          data: {
            shipmentId: shipment.id,
            eventType:  "STATUS_CHANGE",
            fromStatus: shipment.status,
            toStatus:   "IN_TRANSIT",
            message:    `Third-party fulfillment created in Shopify (tracking: ${trackingNumbers.join(", ") || "none"})`,
          },
        }),
      ]);
    });
  } catch (err) {
    console.error("[webhook] fulfillments/create error", { shop, error: err?.message });
  }

  return new Response("OK", { status: 200 });
};
