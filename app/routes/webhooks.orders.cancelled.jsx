import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";
import { LeopardApiClient } from "../integrations/leopards/client.server";
import { getSettings } from "../services/settings.server";
import { isTerminal, canTransition } from "../lib/shipment-state-machine.server";
import { withWebhookDedup } from "../lib/webhook-dedup.server";
import { cancelFulfillmentInShopify } from "../services/shipment.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  try {
    const store = await db.store.findUnique({ where: { shopDomain: shop } });
    if (!store) return new Response("OK", { status: 200 });

    await withWebhookDedup(store.id, topic, payload, async () => {
      const shopifyOrderId = `gid://shopify/Order/${payload.id}`;

      const shipment = await db.shipment.findUnique({
        where: { storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId } },
      });

      // State machine: terminal statuses are immutable
      if (!shipment || isTerminal(shipment.status)) return;

      // Verify transition is valid
      if (!canTransition(shipment.status, "CANCELLED")) {
        console.warn(`[webhook] orders/cancelled: cannot cancel from ${shipment.status} for ${shopifyOrderId}`);
        return;
      }

      let cancelMessage = "Order cancelled in Shopify; shipment was not yet booked with Leopards.";
      const isBooked = shipment.cnNumber &&
        (shipment.status === "BOOKED" || shipment.status === "IN_TRANSIT");

      if (isBooked) {
        try {
          const settings = await getSettings(store.id, { decrypt: true });
          if (settings.leopardApiKey && settings.leopardApiPassword) {
            const client = new LeopardApiClient({ storeId: store.id, settings });
            const result = await client.cancelBookedPackets([shipment.cnNumber]);
            cancelMessage = result.ok
              ? "Order cancelled in Shopify; Leopards cancel succeeded."
              : `Order cancelled in Shopify; Leopards cancel failed: ${result.message ?? "unknown"}`;
          } else {
            cancelMessage = "Order cancelled in Shopify; Leopards cancel skipped (no credentials).";
          }
        } catch (err) {
          console.error("[webhook] orders/cancelled — Leopards cancel error:", err?.message);
          cancelMessage = `Order cancelled in Shopify; Leopards cancel errored: ${err?.message ?? "unknown"}`;
        }
      }

      await db.$transaction([
        db.shipment.update({
          where: { id: shipment.id },
          data:  { status: "CANCELLED", cancelledAt: new Date() },
        }),
        db.shipmentLog.create({
          data: {
            shipmentId: shipment.id,
            eventType:  "CANCELLED",
            fromStatus: shipment.status,
            toStatus:   "CANCELLED",
            message:    cancelMessage,
          },
        }),
      ]);

      // Cancel the Shopify fulfillment so tracking is cleared from the order.
      // Non-fatal: failure here must not affect the 200 response to Shopify.
      try {
        const { admin } = await unauthenticated.admin(shop);
        await cancelFulfillmentInShopify(admin, shopifyOrderId);
      } catch (fulfillErr) {
        console.warn("[webhook] orders/cancelled — fulfillment cancel failed:", fulfillErr?.message);
      }
    });
  } catch (err) {
    console.error("[webhook] orders/cancelled error", { shop, error: err?.message });
  }

  return new Response("OK", { status: 200 });
};
