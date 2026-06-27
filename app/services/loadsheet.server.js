import db from "../db.server";
import { LeopardApiClient } from "../integrations/leopards/client.server";
import { getSettings } from "./settings.server";

export async function listLoadsheets(storeId) {
  return db.loadsheet.findMany({
    where:   { storeId },
    orderBy: { createdAt: "desc" },
    include: { shipments: { include: { shipment: true } } },
    take:    100,
  });
}

function extractLoadSheetId(result) {
  return (
    result.data?.load_sheet_id ??
    result.raw?.load_sheet_id ??
    result.data?.loadSheetId ??
    result.raw?.loadSheetId
  );
}

export async function generateLoadsheet(storeId, cnNumbers) {
  if (!Array.isArray(cnNumbers) || cnNumbers.length === 0) {
    return { ok: false, message: "Select at least one shipment." };
  }
  if (cnNumbers.length > 500) {
    return { ok: false, message: "Maximum 500 shipments per loadsheet." };
  }

  const shipments = await db.shipment.findMany({
    where: {
      storeId,
      cnNumber: { in: cnNumbers },
      status:   { notIn: ["CANCELLED", "DELIVERED", "RETURNED"] },
    },
  });

  if (!shipments.length) {
    return { ok: false, message: "Select booked, active shipments first." };
  }

  const settings = await getSettings(storeId, { decrypt: true });
  const client   = new LeopardApiClient({ storeId, settings });
  const result   = await client.generateLoadSheet(shipments.map((s) => s.cnNumber));

  if (!result.ok) return { ok: false, message: result.message };

  const loadSheetId = String(extractLoadSheetId(result) ?? "");
  if (!loadSheetId) {
    return { ok: false, message: "Leopards did not return a loadsheet ID." };
  }

  // @@unique([storeId, loadSheetId]) prevents duplicate records from double-clicks.
  // Use upsert to be idempotent — if Leopards returns the same ID twice, we don't duplicate.
  try {
    const loadsheet = await db.loadsheet.create({
      data: {
        storeId,
        loadSheetId,
        courierName: "Leopards Courier",
        courierCode: "LCS",
        cnCount:     shipments.length,
        shipments:   {
          create: shipments.map((s) => ({ shipmentId: s.id })),
        },
      },
    });

    return {
      ok:          true,
      message:     `Loadsheet ${loadsheet.loadSheetId} generated (${shipments.length} shipments).`,
      loadSheetId: loadsheet.loadSheetId,
    };
  } catch (err) {
    // P2002 = unique constraint violation — loadsheet with this ID already exists
    if (err.code === "P2002") {
      const existing = await db.loadsheet.findFirst({ where: { storeId, loadSheetId } });
      return {
        ok:          true,
        message:     `Loadsheet ${loadSheetId} already exists.`,
        loadSheetId: existing?.loadSheetId ?? loadSheetId,
      };
    }
    throw err;
  }
}

export async function downloadLoadsheet(storeId, loadSheetId) {
  const loadsheet = await db.loadsheet.findFirst({ where: { storeId, loadSheetId } });
  if (!loadsheet) return { ok: false, message: "Loadsheet not found." };

  const settings = await getSettings(storeId, { decrypt: true });
  const client   = new LeopardApiClient({ storeId, settings });
  const result   = await client.downloadLoadSheet(loadSheetId);

  if (!result.ok) return { ok: false, message: result.message };

  await db.loadsheet.update({
    where: { id: loadsheet.id },
    data:  { status: "downloaded" },
  });

  return result;
}
