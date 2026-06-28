import { authenticate } from "../shopify.server";
import db from "../db.server";
import { codFromFinancialStatus } from "../lib/cod.server";
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
      if (!shipment) return;

      // Always update the stored financialStatus so the Orders page reflects the current state.
      const financialStatus = (order.financial_status ?? "PAID").toUpperCase();
      const totalPrice      = Math.round(parseFloat(order.current_total_price ?? order.total_price ?? "0") || 0);

      if (shipment.status === "PENDING") {
        // Pre-booking: recalculate codAmount. PAID → 0; anything else → total.
        await db.shipment.update({
          where: { id: shipment.id },
          data:  {
            financialStatus,
            totalPrice,
            codAmount: codFromFinancialStatus(financialStatus, totalPrice),
          },
        });
      } else {
        // Post-booking: update financialStatus for display ONLY.
        // codAmount is LOCKED — do NOT change it; it was already sent to Leopards.
        await db.shipment.update({
          where: { id: shipment.id },
          data:  { financialStatus, totalPrice },
        });
      }
    });
  } catch (err) {
    console.error("[webhook] orders/paid error", { shop, error: err?.message });
  }

  return new Response("OK", { status: 200 });
};
