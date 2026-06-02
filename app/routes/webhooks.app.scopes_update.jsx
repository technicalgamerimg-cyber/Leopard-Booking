import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  let shop, topic, payload, session;
  try {
    ({ shop, topic, payload, session } = await authenticate.webhook(request));
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("[webhook] authenticate failed:", err);
    return new Response("Bad Request", { status: 400 });
  }

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    if (session) {
      const current = payload?.current;
      if (current !== undefined) {
        await db.session.updateMany({
          where: { shop, id: session.id },
          data: { scope: String(current) },
        });
      }
    }
  } catch (err) {
    console.error(`[${topic}] ${shop}:`, err);
  }

  return new Response("OK", { status: 200 });
};
