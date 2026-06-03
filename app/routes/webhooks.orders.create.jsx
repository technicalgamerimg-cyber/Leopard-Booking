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
      const order           = payload;
      const shopifyOrderId  = `gid://shopify/Order/${order.id}`;
      const codKeywords     = getCodKeywords(store.settings);
      const codAmount       = calculateCodAmount(
        order.payment_gateway_names,
        order.current_total_price ?? order.total_price,
        codKeywords,
      );

      const addr = order.shipping_address ?? order.billing_address;

      await db.shipment.upsert({
        where: { storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId } },
        create: {
          storeId:          store.id,
          shopifyOrderId,
          shopifyOrderName: order.name,
          status:           "PENDING",
          codAmount,
          weightGrams:      store.settings?.defaultWeightGrams ?? 1000,
          consigneeName:    addr?.name ?? "Unknown",
          consigneePhone:   addr?.phone ?? order.phone ?? "",
          consigneeAddress: [addr?.address1, addr?.address2, addr?.city, addr?.province, addr?.zip]
            .filter(Boolean)
            .join(", "),
        },
        update: {}, // never overwrite an existing record's data from this webhook
      });
    });
  } catch (err) {
    console.error("[webhook] orders/create error", { shop, error: err?.message });
  }

  return new Response("OK", { status: 200 });
};
