import { authenticate } from "../shopify.server";
import db from "../db.server";
import { codFromFinancialStatus } from "../lib/cod.server";
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

      // financialStatus from Shopify is uppercase (PAID, PENDING, etc.)
      const financialStatus = (order.financial_status ?? "PENDING").toUpperCase();
      const totalPrice      = Math.round(parseFloat(order.current_total_price ?? order.total_price ?? "0") || 0);
      const codAmount       = codFromFinancialStatus(financialStatus, totalPrice);

      const addr = order.shipping_address ?? order.billing_address;

      await db.shipment.upsert({
        where: { storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId } },
        create: {
          storeId:          store.id,
          shopifyOrderId,
          shopifyOrderName: order.name,
          shopifyCreatedAt: order.created_at ? new Date(order.created_at) : new Date(),
          financialStatus,
          totalPrice,
          note:             order.note ?? null,
          lineItemsCount:   order.line_items?.length ?? 1,
          status:           "PENDING",
          codAmount,
          weightGrams:      store.settings?.defaultWeightGrams ?? 1000,
          consigneeName:    addr?.name ?? "Unknown",
          consigneePhone:   addr?.phone ?? order.phone ?? "",
          consigneeAddress: [addr?.address1, addr?.address2, addr?.city, addr?.province, addr?.zip]
            .filter(Boolean)
            .join(", "),
        },
        update: {}, // never overwrite an existing record from this webhook
      });
    });
  } catch (err) {
    console.error("[webhook] orders/create error", { shop, error: err?.message });
  }

  return new Response("OK", { status: 200 });
};
