import { authenticate } from "../shopify.server";
import db from "../db.server";
import { LeopardApiClient } from "../integrations/leopards/client.server";
import { getSettings } from "../services/settings.server";
import { isTerminal } from "../lib/shipment-state-machine.server";

const LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    const store = await db.store.findUnique({ where: { shopDomain: shop } });
    if (!store) return new Response("OK", { status: 200 });

    const shopifyOrderId = `gid://shopify/Order/${payload.id}`;

    const shipment = await db.shipment.findUnique({
      where: { storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId } },
    });

    if (!shipment || isTerminal(shipment.status)) {
      // Even for terminal shipments, mark as soft-deleted so queries exclude it
      if (shipment) {
        await db.shipment.update({
          where: { id: shipment.id },
          data:  { shopifyDeletedAt: new Date() },
        });
      }
      return new Response("OK", { status: 200 });
    }

    // If a booking is in flight, record the pending cancellation and soft-delete.
    const isLockActive = shipment.bookingLockedAt &&
      (Date.now() - new Date(shipment.bookingLockedAt).getTime()) < LOCK_TIMEOUT_MS;

    if (isLockActive) {
      await db.shipment.update({
        where: { id: shipment.id },
        data:  { pendingCancellation: true, shopifyDeletedAt: new Date() },
      });
      return new Response("OK", { status: 200 });
    }

    // Cancel with Leopards if already booked — the order is permanently gone from Shopify
    // so there is no fulfillment to cancel, but the Leopards CN must be released.
    let cancelMessage = "Order permanently deleted from Shopify; shipment was not yet booked.";
    const isBooked = shipment.cnNumber &&
      (shipment.status === "BOOKED" || shipment.status === "IN_TRANSIT");

    if (isBooked) {
      try {
        const settings = await getSettings(store.id, { decrypt: true });
        if (settings.leopardApiKey && settings.leopardApiPassword) {
          const client = new LeopardApiClient({ storeId: store.id, settings });
          const result = await client.cancelBookedPackets([shipment.cnNumber]);
          cancelMessage = result.ok
            ? "Order deleted from Shopify; Leopards cancel succeeded."
            : `Order deleted from Shopify; Leopards cancel failed: ${result.message ?? "unknown"}`;
        } else {
          cancelMessage = "Order deleted from Shopify; Leopards cancel skipped (no credentials).";
        }
      } catch (err) {
        console.error("[webhook] orders/delete — Leopards cancel error:", err?.message);
        cancelMessage = `Order deleted from Shopify; Leopards cancel errored: ${err?.message ?? "unknown"}`;
      }
    }

    await db.$transaction([
      db.shipment.update({
        where: { id: shipment.id },
        data:  {
          status:          "CANCELLED",
          cancelledAt:     new Date(),
          shopifyDeletedAt: new Date(),  // soft-delete — never hard-delete
          pendingCancellation: false,
        },
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
  } catch (err) {
    console.error("[webhook] orders/delete error", { topic, shop, error: err?.message });
  }

  return new Response("OK", { status: 200 });
};
