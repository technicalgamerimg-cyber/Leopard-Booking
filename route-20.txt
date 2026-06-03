import { authenticate } from "../shopify.server";
import db from "../db.server";
import { markStoreUninstalled } from "../services/store.server";

export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    await db.session.deleteMany({ where: { shop } });
    await markStoreUninstalled(shop);
  } catch (err) {
    console.error("webhook db error", { topic, shop, error: err?.message });
  }

  return new Response("OK", { status: 200 });
};
