import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    const store = await db.store.findUnique({ where: { shopDomain: shop } });
    if (!store) return new Response();

    const fulfillment = payload;
    const shopifyOrderId = `gid://shopify/Order/${fulfillment.order_id}`;

    const shipment = await db.shipment.findUnique({
      where: { storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId } },
    });

    // Only advance shipments that haven't been dispatched or completed yet.
    const advanceable = ["PENDING", "BOOKED"];
    if (!shipment || !advanceable.includes(shipment.status)) return new Response();

    const trackingNumbers = fulfillment.tracking_numbers ?? [];

    await db.$transaction([
      db.shipment.update({
        where: { id: shipment.id },
        data: { status: "IN_TRANSIT" },
      }),
      db.shipmentLog.create({
        data: {
          shipmentId: shipment.id,
          eventType: "STATUS_CHANGE",
          fromStatus: shipment.status,
          toStatus: "IN_TRANSIT",
          message: `Fulfillment created in Shopify (tracking: ${trackingNumbers.join(", ") || "none"})`,
        },
      }),
    ]);
  } catch (err) {
    console.error(`[${topic}] ${shop}:`, err);
  }

  return new Response();
};
