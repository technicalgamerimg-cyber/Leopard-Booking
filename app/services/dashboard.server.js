import db from "../db.server";
import { getSettings } from "./settings.server";

export async function getDashboard(storeId) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [shipments, awaitingBooking, failedBookings, bookedToday, recentLogs, recentLoadsheets, settings] =
    await Promise.all([
      db.shipment.groupBy({
        by: ["status"],
        where: { storeId },
        _count: { _all: true },
      }),
      db.shipment.count({
        where: { storeId, status: "PENDING", cnNumber: null, lastError: null },
      }),
      db.shipment.count({
        where: { storeId, status: "PENDING", lastError: { not: null } },
      }),
      db.shipment.count({
        where: { storeId, status: "BOOKED", bookedAt: { gte: todayStart } },
      }),
      db.shipmentLog.findMany({
        where: { shipment: { storeId } },
        select: {
          id: true,
          eventType: true,
          message: true,
          createdAt: true,
          shipment: { select: { shopifyOrderName: true, cnNumber: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 8,
      }),
      db.loadsheet.findMany({
        where: { storeId },
        orderBy: { createdAt: "desc" },
        take: 5,
      }),
      getSettings(storeId),
    ]);

  const counts = {
    total: 0,
    PENDING: 0,
    BOOKED: 0,
    IN_TRANSIT: 0,
    DELIVERED: 0,
    RETURNED: 0,
    CANCELLED: 0,
    EXCEPTION: 0,
  };

  for (const row of shipments) {
    counts[row.status] = row._count._all;
    counts.total += row._count._all;
  }

  return {
    counts,
    awaitingBooking,
    failedBookings,
    bookedToday,
    hasCredentials: Boolean(settings.hasCredentials),
    hasOriginCity: Boolean(settings.originCityId),
    recentLogs: recentLogs.map((log) => ({
      id: log.id,
      orderName: log.shipment.shopifyOrderName,
      cnNumber: log.shipment.cnNumber,
      eventType: log.eventType,
      message: log.message,
      createdAt: log.createdAt.toISOString(),
    })),
    recentLoadsheets: recentLoadsheets.map((ls) => ({
      id: ls.id,
      loadSheetId: ls.loadSheetId,
      cnCount: ls.cnCount,
      status: ls.status,
      createdAt: ls.createdAt.toISOString(),
    })),
  };
}
