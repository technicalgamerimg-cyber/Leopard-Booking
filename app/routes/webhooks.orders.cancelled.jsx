import { authenticate } from "../shopify.server";
import db from "../db.server";
import { LeopardApiClient } from "../integrations/leopards/client.server";
import { getSettings } from "../services/settings.server";

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

    if (!shipment || shipment.status === "CANCELLED" || shipment.status === "DELIVERED") {
      return new Response("OK", { status: 200 });
    }

    let cancelMessage = "Order cancelled in Shopify; shipment was not yet booked with Leopards.";
    const isBooked = shipment.cnNumber && (shipment.status === "BOOKED" || shipment.status === "IN_TRANSIT");

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
        console.error("webhook leopards cancel error", { topic, shop, error: err?.message });
        cancelMessage = `Order cancelled in Shopify; Leopards cancel errored: ${err?.message ?? "unknown"}`;
      }
    }

    await db.$transaction([
      db.shipment.update({
        where: { id: shipment.id },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      }),
      db.shipmentLog.create({
        data: {
          shipmentId: shipment.id,
          eventType: "CANCELLED",
          fromStatus: shipment.status,
          toStatus: "CANCELLED",
          message: cancelMessage,
        },
      }),
    ]);
  } catch (err) {
    console.error("webhook db error", { topic, shop, error: err?.message });
  }

  return new Response("OK", { status: 200 });
};
