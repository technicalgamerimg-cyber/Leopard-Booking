import db from "../db.server";
import { encryptSecret } from "../lib/crypto.server";

export async function ensureStore(session) {
  if (!session?.shop) {
    throw new Response("Unauthorized", { status: 401 });
  }

  const encryptedToken = session.accessToken
    ? encryptSecret(session.accessToken)
    : "";

  return db.store.upsert({
    where: { shopDomain: session.shop },
    create: {
      shopDomain: session.shop,
      accessToken: encryptedToken,
      scopes: session.scope,
      settings: {
        create: {
          defaultWeightGrams: Number(process.env.DEFAULT_PACKET_WEIGHT_GRAMS ?? 1000),
          leopardEnvironment: process.env.LEOPARDS_DEFAULT_ENVIRONMENT === "production"
            ? "production"
            : "staging",
        },
      },
    },
    update: {
      accessToken: encryptedToken,
      scopes: session.scope,
      isActive: true,
      uninstalledAt: null,
    },
  });
}

export async function markStoreUninstalled(shop) {
  const store = await db.store.findUnique({ where: { shopDomain: shop } });

  if (!store) return null;

  await db.settings.updateMany({
    where: { storeId: store.id },
    data: {
      leopardApiKey: null,
      leopardApiPassword: null,
    },
  });

  return db.store.update({
    where: { id: store.id },
    data: {
      isActive: false,
      uninstalledAt: new Date(),
    },
  });
}
