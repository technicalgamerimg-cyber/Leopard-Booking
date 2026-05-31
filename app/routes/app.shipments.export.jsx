import { authenticate } from "../shopify.server";
import { ensureStore } from "../services/store.server";
import { listShipmentsForExport } from "../services/shipment.server";
import { batchResolveCityNames } from "../services/city.server";

const HEADERS = [
  "Order",
  "CN Number",
  "Status",
  "Leopards Status",
  "Consignee",
  "Phone",
  "Address",
  "COD",
  "Weight (g)",
  "Origin City",
  "Destination City",
  "Booked Date",
  "Delivered Date",
  "Cancelled Date",
  "Last Error",
];

function escapeCell(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function formatDate(date) {
  if (!date) return "";
  return date instanceof Date ? date.toISOString() : String(date);
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStore(session);
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "";
  const query = url.searchParams.get("query") ?? "";

  const shipments = await listShipmentsForExport(store.id, status, query);

  const cityIds = [];
  for (const s of shipments) {
    if (s.originCityId) cityIds.push(s.originCityId);
    if (s.destinationCityId) cityIds.push(s.destinationCityId);
  }
  const cityNameMap = await batchResolveCityNames(store.id, cityIds);

  const rows = [HEADERS.join(",")];
  for (const s of shipments) {
    rows.push(
      [
        s.shopifyOrderName,
        s.cnNumber ?? "",
        s.status,
        s.leopardStatusRaw ?? "",
        s.consigneeName,
        s.consigneePhone,
        s.consigneeAddress,
        s.codAmount,
        s.weightGrams,
        s.originCityId ? cityNameMap.get(s.originCityId) ?? s.originCityId : "",
        s.destinationCityId
          ? cityNameMap.get(s.destinationCityId) ?? s.destinationCityId
          : "",
        formatDate(s.bookedAt),
        formatDate(s.deliveredAt),
        formatDate(s.cancelledAt),
        s.lastError ?? "",
      ]
        .map(escapeCell)
        .join(","),
    );
  }

  const csv = rows.join("\r\n");

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="shipments-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
};
