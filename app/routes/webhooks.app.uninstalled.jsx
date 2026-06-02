import { authenticate } from "../shopify.server";
import db from "../db.server";
import { markStoreUninstalled } from "../services/store.server";

export const action = async ({ request }) => {
  let shop, topic;
  try {
    ({ shop, topic } = await authenticate.webhook(request));
  } catch (err) {
    // authenticate.webhook throws a Response on HMAC failure (401/400).
    // Re-throw it so Shopify gets the correct status — do NOT swallow it.
    if (err instanceof Response) throw err;
    console.error("[webhook] authenticate failed:", err);
    return new Response("Bad Request", { status: 400 });
  }

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    await db.session.deleteMany({ where: { shop } });
    await markStoreUninstalled(shop);
  } catch (err) {
    console.error(`[${topic}] ${shop}:`, err);
  }

  return new Response("OK", { status: 200 });
};
