import { authenticate } from "../shopify.server";
import db from "../db.server";

const STATUS_MAP = {
  delivered: "DELIVERED",
  in_transit: "IN_TRANSIT",
  out_for_delivery: "IN_TRANSIT",
  returned_to_sender: "RETURNED",
  failure: "EXCEPTION",
};

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

    if (!shipment) return new Response();

    const newStatus = STATUS_MAP[fulfillment.shipment_status];
    if (!newStatus || newStatus === shipment.status) return new Response();

    await db.$transaction([
      db.shipment.update({
        where: { id: shipment.id },
        data: {
          status: newStatus,
          ...(newStatus === "DELIVERED" ? { deliveredAt: new Date() } : {}),
        },
      }),
      db.shipmentLog.create({
        data: {
          shipmentId: shipment.id,
          eventType: "STATUS_CHANGE",
          fromStatus: shipment.status,
          toStatus: newStatus,
          message: `Fulfillment status updated to '${fulfillment.shipment_status}' in Shopify`,
        },
      }),
    ]);
  } catch (err) {
    console.error(`[${topic}] ${shop}:`, err);
  }

  return new Response();
};
