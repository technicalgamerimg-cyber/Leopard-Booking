import { authenticate } from "../shopify.server";
import db from "../db.server";

function determineFulfillmentSource(fulfillment) {
  const service = fulfillment?.service || fulfillment?.fulfillment_service || "";
  if (!service || service === "manual") return "SHOPIFY_ADMIN";
  return "THIRD_PARTY";
}

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    const store = await db.store.findUnique({ where: { shopDomain: shop } });
    if (!store) return new Response("OK", { status: 200 });

    const shopifyOrderId = `gid://shopify/Order/${payload.id}`;

    const shipment = await db.shipment.findUnique({
      where: { storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId } },
    });

    const advanceable = ["PENDING", "BOOKED"];
    if (!shipment || !advanceable.includes(shipment.status)) return new Response("OK", { status: 200 });

    // Guard: only advance to IN_TRANSIT if this order was booked through our app (has a CN).
    // Without a CN, this fulfillment was created externally — record it for audit and block booking.
    if (!shipment.cnNumber) {
      const latestFulfillment = payload.fulfillments?.[payload.fulfillments.length - 1];
      const source            = determineFulfillmentSource(latestFulfillment);
      const externalId        = latestFulfillment?.id
        ? `gid://shopify/Fulfillment/${latestFulfillment.id}`
        : null;
      const externalTracking  = latestFulfillment?.tracking_number ?? null;

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
          eventType:  "WEBHOOK_RECEIVED",
          fromStatus: shipment.status,
          toStatus:   shipment.status,
          message:    `External fulfillment detected (${source}) via orders/fulfilled; booking not affected.`,
        },
      });
      return; // stay PENDING — do not advance to IN_TRANSIT
    }

    // Booked through our app — advance to IN_TRANSIT
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
          message:    "Order marked as fulfilled in Shopify",
        },
      }),
    ]);
  } catch (err) {
    console.error("[webhook] orders/fulfilled error", { topic, shop, error: err?.message });
  }

  return new Response("OK", { status: 200 });
};
