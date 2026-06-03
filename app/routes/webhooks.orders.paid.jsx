import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getCodKeywords } from "../services/settings.server";
import { calculateCodAmount } from "../lib/cod.server";
import { withWebhookDedup } from "../lib/webhook-dedup.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  try {
    const store = await db.store.findUnique({
      where:   { shopDomain: shop },
      include: { settings: true },
    });
    if (!store) return new Response("OK", { status: 200 });

    await withWebhookDedup(store.id, topic, payload, async () => {
      const order          = payload;
      const shopifyOrderId = `gid://shopify/Order/${order.id}`;

      const shipment = await db.shipment.findUnique({
        where: { storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId } },
      });

      // Only update COD on PENDING shipments — never overwrite a BOOKED+ shipment's COD
      if (!shipment || shipment.status !== "PENDING") return;

      const codKeywords = getCodKeywords(store.settings);
      const codAmount   = calculateCodAmount(
        order.payment_gateway_names,
        order.current_total_price ?? order.total_price,
        codKeywords,
      );

      await db.shipment.update({
        where: { id: shipment.id },
        data:  { codAmount },
      });
    });
  } catch (err) {
    console.error("[webhook] orders/paid error", { shop, error: err?.message });
  }

  return new Response("OK", { status: 200 });
};
