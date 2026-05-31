import db from "../db.server";
import { LeopardApiClient } from "../integrations/leopards/client.server";
import { getSettings } from "./settings.server";

export async function listLoadsheets(storeId) {
  return db.loadsheet.findMany({
    where: { storeId },
    orderBy: { createdAt: "desc" },
    include: { shipments: { include: { shipment: true } } },
    take: 100,
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
  const shipments = await db.shipment.findMany({
    where: {
      storeId,
      cnNumber: { in: cnNumbers },
      status: { notIn: ["CANCELLED", "DELIVERED", "RETURNED"] },
    },
  });

  if (!shipments.length) {
    return { ok: false, message: "Select booked, active shipments first." };
  }

  const settings = await getSettings(storeId, { decrypt: true });
  const client = new LeopardApiClient({ storeId, settings });
  const result = await client.generateLoadSheet(
    shipments.map((shipment) => shipment.cnNumber),
  );

  if (!result.ok) return result;

  const loadSheetId = String(extractLoadSheetId(result) ?? "");
  if (!loadSheetId) {
    return { ok: false, message: "Leopards did not return a loadsheet id." };
  }

  const loadsheet = await db.loadsheet.create({
    data: {
      storeId,
      loadSheetId,
      courierName: "Leopards Courier",
      courierCode: "LCS",
      cnCount: shipments.length,
      shipments: {
        create: shipments.map((shipment) => ({
          shipmentId: shipment.id,
        })),
      },
    },
  });

  await db.shipment.updateMany({
    where: {
      id: { in: shipments.map((shipment) => shipment.id) }
    },
    data: {
      lastError: null,
    }
  });

  return {
    ok: true,
    message: `Loadsheet ${loadsheet.loadSheetId} generated.`,
    loadSheetId: loadsheet.loadSheetId,
  };
}

export async function downloadLoadsheet(storeId, loadSheetId) {
  const loadsheet = await db.loadsheet.findFirst({
    where: { storeId, loadSheetId },
  });

  if (!loadsheet) {
    return { ok: false, message: "Loadsheet not found." };
  }

  const settings = await getSettings(storeId, { decrypt: true });
  const client = new LeopardApiClient({ storeId, settings });
  const result = await client.downloadLoadSheet(loadSheetId);

  if (!result.ok) return result;

  await db.loadsheet.update({
    where: { id: loadsheet.id },
    data: { status: "downloaded" },
  });

  return result;
}
