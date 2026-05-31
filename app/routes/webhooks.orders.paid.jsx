import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getCodKeywords } from "../services/settings.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    const store = await db.store.findUnique({
      where: { shopDomain: shop },
      include: { settings: true },
    });
    if (!store) return new Response();

    const order = payload;
    const shopifyOrderId = `gid://shopify/Order/${order.id}`;

    const shipment = await db.shipment.findUnique({
      where: { storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId } },
    });

    // Only update COD amount while the shipment hasn't been dispatched yet.
    if (!shipment || shipment.status !== "PENDING") return new Response();

    const codKeywords = getCodKeywords(store.settings);
    const gatewayText = (order.payment_gateway_names ?? []).join(" ").toLowerCase();
    const isCod = Boolean(gatewayText) && codKeywords.some((kw) => gatewayText.includes(kw));
    const totalAmount = parseFloat(order.current_total_price ?? order.total_price ?? "0");

    await db.shipment.update({
      where: { id: shipment.id },
      data: { codAmount: isCod ? Math.round(totalAmount) : 0 },
    });
  } catch (err) {
    console.error(`[${topic}] ${shop}:`, err);
  }

  return new Response();
};
