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

      const financialStatus = (order.financial_status ?? "PENDING").toUpperCase();
      const totalPrice      = Math.round(parseFloat(order.current_total_price ?? order.total_price ?? "0") || 0);

      // Shopify-sourced fields are always kept in sync (for display and future COD calculations).
      // codAmount is NOT updated post-booking — it was already sent to Leopards.
      const alwaysUpdate = {
        financialStatus,
        totalPrice,
        note:          order.note ?? null,
        lineItemsCount: order.line_items?.length ?? shipment.lineItemsCount,
      };

      // Consignee fields are only updated while still PENDING (not yet booked with Leopards).
      let consigneeUpdate = {};
      if (shipment.status === "PENDING") {
        const addr = order.shipping_address;
        if (addr) {
          const newAddress = [addr.address1, addr.address2, addr.city, addr.province, addr.zip]
            .filter(Boolean)
            .join(", ");
          consigneeUpdate = {
            consigneeName:    addr.name    ?? shipment.consigneeName,
            consigneePhone:   addr.phone   ?? order.phone ?? shipment.consigneePhone,
            consigneeAddress: newAddress   || shipment.consigneeAddress,
          };

          // Also update codAmount while PENDING since totalPrice or financialStatus may have changed.
          consigneeUpdate.codAmount = codFromFinancialStatus(financialStatus, totalPrice);
        }
      }

      await db.shipment.update({
        where: { id: shipment.id },
        data:  { ...alwaysUpdate, ...consigneeUpdate },
      });
    });
  } catch (err) {
    console.error("[webhook] orders/updated error", { shop, error: err?.message });
  }

  return new Response("OK", { status: 200 });
};
