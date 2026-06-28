import { authenticate } from "../shopify.server";
import db from "../db.server";
import { canTransition } from "../lib/shipment-state-machine.server";
import { withWebhookDedup } from "../lib/webhook-dedup.server";

function determineFulfillmentSource(service) {
  if (!service || service === "manual") return "SHOPIFY_ADMIN";
  return "THIRD_PARTY";
}

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

      const trackingNumbers = fulfillment.tracking_numbers ?? [];

      // Skip if this fulfillment was created by our own writeback.
      // When we call writebackFulfillment() after booking, Shopify fires this webhook.
      // Without this guard the shipment would prematurely advance to IN_TRANSIT.
      if (shipment.cnNumber && trackingNumbers.includes(shipment.cnNumber)) {
        // Record our fulfillment ID for the audit trail
        if (!shipment.ourFulfillmentId && fulfillment.id) {
          await db.shipment.update({
            where: { id: shipment.id },
            data:  { ourFulfillmentId: `gid://shopify/Fulfillment/${fulfillment.id}` },
          });
        }
        return;
      }

      // Guard: only advance to IN_TRANSIT if this order was booked through our app.
      if (!shipment.cnNumber) {
        // External fulfillment — record for audit and to block booking with a warning.
        // These fields are never cleared even after a "Book Anyway".
        const source          = determineFulfillmentSource(fulfillment.service);
        const externalId      = `gid://shopify/Fulfillment/${fulfillment.id}`;
        const externalTracking = trackingNumbers[0] ?? null;

        await db.shipment.update({
          where: { id: shipment.id },
          data:  {
            externalFulfillmentSource:     source,
            externalFulfillmentId:         externalId,
            externalTrackingNumber:        externalTracking,
            externalFulfillmentDetectedAt: new Date(),
          },
        });
        await db.shipmentLog.create({
          data: {
            shipmentId: shipment.id,
            eventType:  "SHOPIFY_FULFILLMENT_CREATED",
            fromStatus: shipment.status,
            toStatus:   shipment.status,
            message:    `External fulfillment detected (${source}, tracking: ${externalTracking ?? "none"}); order stays PENDING.`,
          },
        });
        return; // do NOT advance to IN_TRANSIT
      }

      // Booked through our app — advance if the state machine allows it
      if (!canTransition(shipment.status, "IN_TRANSIT")) return;

      await db.$transaction([
        db.shipment.update({
          where: { id: shipment.id },
          data:  { status: "IN_TRANSIT", shopifySyncStatus: "SYNC_OK" },
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
