import db from "../db.server";
import { LeopardApiClient } from "../integrations/leopards/client.server";
import { mapLeopardStatus } from "../integrations/leopards/status-map.server";
import { getSettings } from "./settings.server";

const TERMINAL_STATUSES = ["DELIVERED", "CANCELLED", "RETURNED"];

export async function listShipments(storeId, status = "", query = "", page = 1, perPage = 50) {
  const where = {
    storeId,
    ...(status ? { status } : {}),
    ...(query
      ? {
          OR: [
            { cnNumber: { contains: query, mode: "insensitive" } },
            { shopifyOrderName: { contains: query, mode: "insensitive" } },
            { consigneeName: { contains: query, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const safePage = Math.max(1, Number(page) || 1);
  const safePerPage = Math.max(1, Math.min(200, Number(perPage) || 50));

  const [shipments, total] = await Promise.all([
    db.shipment.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (safePage - 1) * safePerPage,
      take: safePerPage,
    }),
    db.shipment.count({ where }),
  ]);

  return {
    shipments,
    total,
    page: safePage,
    perPage: safePerPage,
    pageCount: Math.max(1, Math.ceil(total / safePerPage)),
  };
}

export async function listShipmentsForExport(storeId, status = "", query = "") {
  const where = {
    storeId,
    ...(status ? { status } : {}),
    ...(query
      ? {
          OR: [
            { cnNumber: { contains: query, mode: "insensitive" } },
            { shopifyOrderName: { contains: query, mode: "insensitive" } },
            { consigneeName: { contains: query, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  return db.shipment.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    take: 5000,
  });
}

export async function listEligibleShipmentsForLoadsheet(storeId) {
  return db.shipment.findMany({
    where: {
      storeId,
      cnNumber: { not: null },
      status: { notIn: ["CANCELLED", "DELIVERED", "RETURNED"] },
    },
    select: { id: true, cnNumber: true, shopifyOrderName: true, status: true },
    orderBy: { bookedAt: "desc" },
    take: 1000,
  });
}

export async function purgeOldLogs({ apiLogDays = 30, webhookLogDays = 30 } = {}) {
  const apiCutoff = new Date(Date.now() - apiLogDays * 86_400_000);
  const webhookCutoff = new Date(Date.now() - webhookLogDays * 86_400_000);
  const [{ count: apiDeleted }, { count: webhookDeleted }] = await Promise.all([
    db.apiLog.deleteMany({ where: { createdAt: { lt: apiCutoff } } }),
    db.webhookLog.deleteMany({ where: { createdAt: { lt: webhookCutoff } } }),
  ]);
  return { apiDeleted, webhookDeleted };
}

export async function getShipmentById(storeId, shipmentId) {
  return db.shipment.findFirst({
    where: { id: shipmentId, storeId },
    include: {
      logs: { orderBy: { createdAt: "desc" } },
    },
  });
}

function parsePerCnErrors(raw) {
  // Leopards may return: { status: 0, error: { "CN1": "msg", "CN2": "msg" } }
  // or sometimes nested under raw.error / raw.data.
  const errSource = raw?.error ?? raw?.data?.error;
  if (!errSource || typeof errSource !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(errSource)) {
    out[String(key)] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return out;
}

export async function cancelShipments(storeId, cnNumbers) {
  const shipments = await db.shipment.findMany({
    where: {
      storeId,
      cnNumber: { in: cnNumbers },
      status: { notIn: TERMINAL_STATUSES },
    },
  });

  if (!shipments.length) {
    return { ok: false, message: "No cancellable shipments were selected." };
  }

  const settings = await getSettings(storeId, { decrypt: true });
  const client = new LeopardApiClient({ storeId, settings });
  const result = await client.cancelBookedPackets(
    shipments.map((s) => s.cnNumber),
  );

  // Parse per-CN errors regardless of overall ok/fail status.
  const cnErrors = parsePerCnErrors(result?.raw);

  if (!result.ok && Object.keys(cnErrors).length === 0) {
    // Total failure with no per-CN detail — mark every requested CN as failed.
    return {
      ok: false,
      message: result.message ?? "Leopards rejected the cancel request.",
    };
  }

  const cancellableShipments = shipments.filter((s) => !cnErrors[s.cnNumber]);
  const failed = shipments
    .filter((s) => cnErrors[s.cnNumber])
    .map((s) => ({ cn: s.cnNumber, reason: cnErrors[s.cnNumber] }));

  if (cancellableShipments.length === 0) {
    return {
      ok: false,
      message: "Leopards rejected every cancellation.",
      failed,
    };
  }

  const ids = cancellableShipments.map((s) => s.id);
  const now = new Date();

  await db.$transaction([
    db.shipment.updateMany({
      where: { id: { in: ids } },
      data: { status: "CANCELLED", cancelledAt: now, lastError: null },
    }),
    db.shipmentLog.createMany({
      data: cancellableShipments.map((s) => ({
        shipmentId: s.id,
        eventType: "CANCELLED",
        fromStatus: s.status,
        toStatus: "CANCELLED",
        message: "Cancelled through Leopards",
      })),
    }),
  ]);

  const message =
    failed.length > 0
      ? `${cancellableShipments.length} cancelled, ${failed.length} failed.`
      : `${cancellableShipments.length} shipment(s) cancelled.`;

  return {
    ok: true,
    message,
    cancelled: cancellableShipments.length,
    failed,
  };
}

function extractTrackedPackets(result) {
  const source =
    result?.data?.packet_list ??
    result?.raw?.packet_list ??
    result?.data ??
    [];
  return Array.isArray(source) ? source : [];
}

export async function refreshShipmentStatuses(storeId, cnNumbers = []) {
  const settings = await getSettings(storeId, { decrypt: true });
  const shipments = await db.shipment.findMany({
    where: {
      storeId,
      cnNumber: cnNumbers.length ? { in: cnNumbers } : { not: null },
      status: { notIn: TERMINAL_STATUSES },
    },
  });

  if (!shipments.length) {
    return { ok: false, message: "No active shipments need status refresh." };
  }

  const client = new LeopardApiClient({ storeId, settings });

  const CHUNK_SIZE = 50;
  const allCns = shipments.map((s) => s.cnNumber);
  const allPackets = [];

  for (let i = 0; i < allCns.length; i += CHUNK_SIZE) {
    const chunk = allCns.slice(i, i + CHUNK_SIZE);
    const result = await client.trackBookedPacket(chunk);
    if (!result.ok) return result;
    allPackets.push(...extractTrackedPackets(result));
  }

  const byCn = new Map(
    allPackets.map((packet) => [
      String(packet.track_number ?? packet.cn_number ?? packet.CN ?? ""),
      packet,
    ]),
  );

  return applyStatusUpdates(storeId, shipments, byCn);
}

export async function refreshShipmentStatusesByDateRange(storeId, fromDate, toDate) {
  const settings = await getSettings(storeId, { decrypt: true });
  const client = new LeopardApiClient({ storeId, settings });
  const result = await client.getBookedPacketLastStatus(fromDate, toDate);

  if (!result.ok) return result;

  const packets = extractTrackedPackets(result);
  if (!packets.length) {
    return { ok: true, message: "No status updates returned for the selected date range." };
  }

  const cnNumbers = packets
    .map((p) => String(p.tracking_number ?? p.track_number ?? p.cn_number ?? ""))
    .filter(Boolean);

  if (!cnNumbers.length) {
    return { ok: true, message: "No matching CN numbers in the response." };
  }

  const shipments = await db.shipment.findMany({
    where: { storeId, cnNumber: { in: cnNumbers } },
  });

  const byCn = new Map(
    packets.map((packet) => [
      String(packet.tracking_number ?? packet.track_number ?? packet.cn_number ?? ""),
      packet,
    ]),
  );

  return applyStatusUpdates(storeId, shipments, byCn);
}

async function applyStatusUpdates(storeId, shipments, byCn) {
  const shipmentUpdates = [];
  const logEntries = [];

  for (const shipment of shipments) {
    const packet = byCn.get(String(shipment.cnNumber));
    if (!packet) continue;

    const rawStatus =
      packet.booked_packet_status ?? packet.status ?? packet.packet_status;
    const nextStatus = mapLeopardStatus(rawStatus);

    if (!rawStatus) continue;
    if (nextStatus === shipment.status && shipment.leopardStatusRaw === String(rawStatus)) {
      continue;
    }

    shipmentUpdates.push({ shipment, nextStatus, rawStatus: String(rawStatus) });

    if (nextStatus !== shipment.status) {
      logEntries.push({
        shipmentId: shipment.id,
        eventType: "STATUS_CHANGE",
        fromStatus: shipment.status,
        toStatus: nextStatus,
        message: String(rawStatus),
      });
    }
  }

  if (!shipmentUpdates.length) {
    return { ok: true, message: "All statuses are already up to date." };
  }

  // Single transaction with per-row updates (necessary since leopardStatusRaw differs per row).
  // updateMany cannot set different values per row, so individual update() calls are batched into a tx.
  const txOps = shipmentUpdates.map(({ shipment, nextStatus, rawStatus }) =>
    db.shipment.update({
      where: { id: shipment.id },
      data: {
        status: nextStatus,
        leopardStatusRaw: rawStatus,
        ...(nextStatus === "DELIVERED" && shipment.status !== "DELIVERED"
          ? { deliveredAt: new Date() }
          : {}),
        ...(nextStatus === "CANCELLED" && shipment.status !== "CANCELLED"
          ? { cancelledAt: new Date() }
          : {}),
      },
    }),
  );

  if (logEntries.length) {
    txOps.push(db.shipmentLog.createMany({ data: logEntries }));
  }

  await db.$transaction(txOps);

  return {
    ok: true,
    message: `${shipmentUpdates.length} shipment status(es) updated.`,
    updated: shipmentUpdates.length,
  };
}
