import { authenticate } from "../shopify.server";
import db from "../db.server";
import { LeopardApiClient } from "../integrations/leopards/client.server";
import { getSettings } from "../services/settings.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    const store = await db.store.findUnique({ where: { shopDomain: shop } });
    if (!store) return new Response();

    const shopifyOrderId = `gid://shopify/Order/${payload.id}`;

    const shipment = await db.shipment.findUnique({
      where: { storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId } },
    });

    if (!shipment || shipment.status === "CANCELLED" || shipment.status === "DELIVERED") {
      return new Response();
    }

    // If the shipment was booked with Leopards, also cancel it courier-side (best-effort).
    let leopardsCancelMessage = "Order cancelled in Shopify; shipment was not yet booked with Leopards.";
    const isBookedWithLeopards =
      shipment.cnNumber &&
      (shipment.status === "BOOKED" || shipment.status === "IN_TRANSIT");

    if (isBookedWithLeopards) {
      try {
        const settings = await getSettings(store.id, { decrypt: true });
        if (settings.leopardApiKey && settings.leopardApiPassword) {
          const client = new LeopardApiClient({ storeId: store.id, settings });
          const result = await client.cancelBookedPackets([shipment.cnNumber]);
          leopardsCancelMessage = result.ok
            ? "Order cancelled in Shopify; Leopards cancel succeeded."
            : `Order cancelled in Shopify; Leopards cancel failed: ${result.message ?? "unknown"}`;
        } else {
          leopardsCancelMessage =
            "Order cancelled in Shopify; Leopards cancel skipped (no credentials).";
        }
      } catch (err) {
        console.error(`[${topic}] Leopards cancel error:`, err);
        leopardsCancelMessage = `Order cancelled in Shopify; Leopards cancel errored: ${err.message}`;
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
          message: leopardsCancelMessage,
        },
      }),
    ]);
  } catch (err) {
    console.error(`[${topic}] ${shop}:`, err);
  }

  return new Response();
};
