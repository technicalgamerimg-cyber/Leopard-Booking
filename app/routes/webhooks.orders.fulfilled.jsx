import { authenticate } from "../shopify.server";
import db from "../db.server";

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
    console.error("webhook db error", { topic, shop, error: err?.message });
  }

  return new Response("OK", { status: 200 });
};
