import { authenticate } from "../shopify.server";
import db from "../db.server";

// "Fulfilled" in Shopify means the merchant created a fulfillment record (i.e., packaged
// and shipped). This maps to IN_TRANSIT, not DELIVERED. Actual delivery is confirmed by
// the Leopard courier status sync — not by Shopify.
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    const store = await db.store.findUnique({ where: { shopDomain: shop } });
    if (!store) return new Response();

    const shopifyOrderId = `gid://shopify/Order/${payload.id}`;

    const shipment = await db.shipment.findUnique({
      where: { storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId } },
    });

    const advanceable = ["PENDING", "BOOKED"];
    if (!shipment || !advanceable.includes(shipment.status)) return new Response();

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
          message: "Order marked as fulfilled in Shopify",
        },
      }),
    ]);
  } catch (err) {
    console.error(`[${topic}] ${shop}:`, err);
  }

  return new Response();
};
