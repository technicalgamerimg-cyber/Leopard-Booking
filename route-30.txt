import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    const store = await db.store.findUnique({ where: { shopDomain: shop } });
    if (!store) return new Response("OK", { status: 200 });

    const order = payload;
    const shopifyOrderId = `gid://shopify/Order/${order.id}`;

    const shipment = await db.shipment.findUnique({
      where: { storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId } },
    });

    if (!shipment || shipment.status !== "PENDING") return new Response("OK", { status: 200 });

    const addr = order.shipping_address;
    if (!addr) return new Response("OK", { status: 200 });

    const newAddress = [addr.address1, addr.address2, addr.city, addr.province, addr.zip]
      .filter(Boolean)
      .join(", ");

    await db.shipment.update({
      where: { id: shipment.id },
      data: {
        consigneeName: addr.name ?? shipment.consigneeName,
        consigneePhone: addr.phone ?? order.phone ?? shipment.consigneePhone,
        consigneeAddress: newAddress || shipment.consigneeAddress,
      },
    });
  } catch (err) {
    console.error("webhook db error", { topic, shop, error: err?.message });
  }

  return new Response("OK", { status: 200 });
};
