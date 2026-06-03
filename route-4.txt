import db from "../db.server";
import { refreshShipmentStatusesByDateRange } from "../services/shipment.server";

function unauthorized(message = "Unauthorized") {
  return new Response(JSON.stringify({ ok: false, message }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

function methodNotAllowed() {
  return new Response(
    JSON.stringify({ ok: false, message: "Use POST." }),
    {
      status: 405,
      headers: { "Content-Type": "application/json", Allow: "POST" },
    },
  );
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

export const loader = () => methodNotAllowed();

export const action = async ({ request }) => {
  if (request.method !== "POST") return methodNotAllowed();

  const secret = process.env.SYNC_SECRET;
  if (!secret) return unauthorized("SYNC_SECRET is not configured.");

  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ") || auth.slice(7).trim() !== secret) {
    return unauthorized();
  }

  const stores = await db.store.findMany({
    where: {
      isActive: true,
      settings: {
        AND: [
          { leopardApiKey: { not: null } },
          { leopardApiPassword: { not: null } },
        ],
      },
    },
    select: { id: true, shopDomain: true },
  });

  const today = new Date();
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  const fromDate = formatDate(thirtyDaysAgo);
  const toDate = formatDate(today);

  let totalUpdated = 0;
  const errors = [];

  for (const store of stores) {
    try {
      const result = await refreshShipmentStatusesByDateRange(
        store.id,
        fromDate,
        toDate,
      );
      if (result.ok) {
        totalUpdated += result.updated ?? 0;
      } else {
        errors.push({ shop: store.shopDomain, message: result.message });
      }
    } catch (err) {
      errors.push({ shop: store.shopDomain, message: err.message });
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      stores: stores.length,
      updated: totalUpdated,
      errors,
      fromDate,
      toDate,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
};
