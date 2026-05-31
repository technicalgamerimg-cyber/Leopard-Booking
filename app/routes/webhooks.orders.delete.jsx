import { authenticate } from "../shopify.server";
import db from "../db.server";

// Fires when a merchant permanently deletes an order from Shopify Admin.
// Hard-deleted orders can never be recovered, so we cancel any linked shipment.
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

    if (!shipment || shipment.status === "CANCELLED" || shipment.status === "DELIVERED") {
      return new Response();
    }

    await db.$transaction([
      db.shipment.update({
        where: { id: shipment.id },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      }),
      db.shipmentLog.create({
        data: {
          shipmentId: shipment.id,
          eventType: "CANCELLED",
          fromStatus: shipment.status,
          toStatus: "CANCELLED",
          message: "Order permanently deleted from Shopify",
        },
      }),
    ]);
  } catch (err) {
    console.error(`[${topic}] ${shop}:`, err);
  }

  return new Response();
};
