import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    const store = await db.store.findUnique({ where: { shopDomain: shop } });
    if (!store) return new Response();

    // Shopify sends the list of order IDs whose customer PII must be erased.
    const orderIds = (payload.orders_to_redact ?? []).map(
      (id) => `gid://shopify/Order/${id}`,
    );

    if (orderIds.length === 0) return new Response();

    await db.shipment.updateMany({
      where: { storeId: store.id, shopifyOrderId: { in: orderIds } },
      data: {
        consigneeName: "[redacted]",
        consigneePhone: "[redacted]",
        consigneeAddress: "[redacted]",
      },
    });
  } catch (err) {
    console.error(`[${topic}] ${shop}:`, err);
  }

  return new Response();
};
