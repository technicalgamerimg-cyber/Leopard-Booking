import { authenticate } from "../shopify.server";
import db from "../db.server";
import { withWebhookDedup } from "../lib/webhook-dedup.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  try {
    const store = await db.store.findUnique({ where: { shopDomain: shop } });
    if (!store) return new Response("OK", { status: 200 });

    await withWebhookDedup(store.id, topic, payload, async () => {
      const order          = payload;
      const shopifyOrderId = `gid://shopify/Order/${order.id}`;

      const shipment = await db.shipment.findUnique({
        where: { storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId } },
      });

      // Only update consignee data on PENDING shipments — booked shipments cannot be re-addressed
      if (!shipment || shipment.status !== "PENDING") return;

      const addr = order.shipping_address;
      if (!addr) return;

      const newAddress = [addr.address1, addr.address2, addr.city, addr.province, addr.zip]
        .filter(Boolean)
        .join(", ");

      await db.shipment.update({
        where: { id: shipment.id },
        data:  {
          consigneeName:    addr.name ?? shipment.consigneeName,
          consigneePhone:   addr.phone ?? order.phone ?? shipment.consigneePhone,
          consigneeAddress: newAddress || shipment.consigneeAddress,
        },
      });
    });
  } catch (err) {
    console.error("[webhook] orders/updated error", { shop, error: err?.message });
  }

  return new Response("OK", { status: 200 });
};
