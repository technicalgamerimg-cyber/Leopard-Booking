import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  let shop, topic;
  try {
    ({ shop, topic } = await authenticate.webhook(request));
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("[webhook] authenticate failed:", err);
    return new Response("Bad Request", { status: 400 });
  }

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    await db.$transaction([
      db.session.deleteMany({ where: { shop } }),
      db.store.deleteMany({ where: { shopDomain: shop } }),
    ]);
  } catch (err) {
    console.error(`[${topic}] ${shop}:`, err);
  }

  return new Response("OK", { status: 200 });
};
