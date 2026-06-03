import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop, topic, payload, session } = await authenticate.webhook(request);

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
    console.error("webhook db error", { topic, shop, error: err?.message });
  }

  return new Response("OK", { status: 200 });
};
