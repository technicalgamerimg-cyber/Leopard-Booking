import { authenticate } from "../shopify.server";
import db from "../db.server";

// Shopify fires this 48 hours after a store permanently uninstalls the app.
// Delete ALL store data. Session rows must be explicitly deleted — they are not
// cascade-deleted from Store because Session has no FK relation to Store.
export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    await db.$transaction([
      // Sessions have no FK to Store so Prisma cascade won't catch them.
      db.session.deleteMany({ where: { shop } }),
      // Store cascade-deletes: Settings, Shipment (→ ShipmentLog, LoadsheetShipment),
      // Loadsheet, WebhookLog, ApiLog, CityCache.
      db.store.deleteMany({ where: { shopDomain: shop } }),
    ]);
  } catch (err) {
    console.error(`[${topic}] ${shop}:`, err);
  }

  return new Response();
};
