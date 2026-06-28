import db from "../db.server";
import { LeopardApiClient } from "../integrations/leopards/client.server";
import { mapLeopardStatus } from "../integrations/leopards/status-map.server";
import { getSettings } from "./settings.server";
import {
  isTerminal,
  safeTransition,
  cancellableStatuses,
  TERMINAL_STATUSES,
} from "../lib/shipment-state-machine.server";

// ── Shopify fulfillment cancellation GraphQL ──────────────────────────────────

const GET_ORDER_FULFILLMENTS_QUERY = `#graphql
  query GetOrderFulfillments($orderId: ID!) {
    order(id: $orderId) {
      fulfillments(first: 10) {
        id
        status
        trackingInfo { number }
      }
    }
  }
`;

const FULFILLMENT_CANCEL_MUTATION = `#graphql
  mutation FulfillmentCancel($id: ID!) {
    fulfillmentCancel(id: $id) {
      fulfillment { id status }
      userErrors { field message }
    }
  }
`;

const FULFILLMENT_TRACKING_UPDATE_MUTATION = `#graphql
  mutation FulfillmentTrackingInfoUpdateV2($fulfillmentId: ID!, $trackingInfoInput: FulfillmentTrackingInput!, $notifyCustomer: Boolean) {
    fulfillmentTrackingInfoUpdateV2(fulfillmentId: $fulfillmentId, trackingInfoInput: $trackingInfoInput, notifyCustomer: $notifyCustomer) {
      fulfillment { id status }
      userErrors { field message }
    }
  }
`;

// ── Listing / export ─────────────────────────────────────────────────────────

export async function listShipments(storeId, status = "", query = "", page = 1, perPage = 50) {
  const where = buildWhere(storeId, status, query);
  const safePage    = Math.max(1, Number(page) || 1);
  const safePerPage = Math.max(1, Math.min(200, Number(perPage) || 50));

  const [shipments, total] = await Promise.all([
    db.shipment.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip:    (safePage - 1) * safePerPage,
      take:    safePerPage,
    }),
    db.shipment.count({ where }),
  ]);

  return {
    shipments,
    total,
    page:      safePage,
    perPage:   safePerPage,
    pageCount: Math.max(1, Math.ceil(total / safePerPage)),
  };
}

export async function listShipmentsForExport(storeId, status = "", query = "") {
  const [shipments, total] = await Promise.all([
    db.shipment.findMany({ where: buildWhere(storeId, status, query), orderBy: { updatedAt: "desc" }, take: 5000 }),
    db.shipment.count({ where: buildWhere(storeId, status, query) }),
  ]);
  return { shipments, total };
}

export async function listEligibleShipmentsForLoadsheet(storeId) {
  return db.shipment.findMany({
    where: {
      storeId,
      shopifyDeletedAt: null,
      cnNumber: { not: null },
      status:   { notIn: ["CANCELLED", "DELIVERED", "RETURNED"] },
    },
    select:  { id: true, cnNumber: true, shopifyOrderName: true, status: true },
    orderBy: { bookedAt: "desc" },
    take:    1000,
  });
}

export async function getShipmentById(storeId, shipmentId) {
  return db.shipment.findFirst({
    where:   { id: shipmentId, storeId, shopifyDeletedAt: null },
    include: { logs: { orderBy: { createdAt: "desc" } } },
  });
}

export async function purgeOldLogs({ apiLogDays = 30, webhookLogDays = 30 } = {}) {
  const apiCutoff     = new Date(Date.now() - apiLogDays * 86_400_000);
  const webhookCutoff = new Date(Date.now() - webhookLogDays * 86_400_000);
  const [{ count: apiDeleted }, { count: webhookDeleted }] = await Promise.all([
    db.apiLog.deleteMany({ where: { createdAt: { lt: apiCutoff } } }),
    db.webhookLog.deleteMany({ where: { createdAt: { lt: webhookCutoff } } }),
  ]);
  return { apiDeleted, webhookDeleted };
}

// ── Cancellation ─────────────────────────────────────────────────────────────

/**
 * Cancels the Shopify fulfillment associated with a given Shopify order.
 * - Clears tracking info first (so the customer doesn't see stale tracking).
 * - Then cancels the fulfillment itself.
 * Non-fatal: errors are logged but never thrown to callers.
 *
 * @param {object} admin  - Shopify Admin API client (from authenticate.admin)
 * @param {string} shopifyOrderId - e.g. "gid://shopify/Order/12345"
 */
// Returns { ok: boolean } — never throws.
export async function cancelFulfillmentInShopify(admin, shopifyOrderId) {
  try {
    const foRes = await admin.graphql(GET_ORDER_FULFILLMENTS_QUERY, {
      variables: { orderId: shopifyOrderId },
    });
    const foJson = await foRes.json();
    const fulfillments = foJson.data?.order?.fulfillments ?? [];

    const activeFulfillments = fulfillments.filter(
      (f) => f.status === "SUCCESS" || f.status === "OPEN",
    );

    let allOk = true;
    for (const fulfillment of activeFulfillments) {
      // Step A: Clear tracking info
      try {
        const trackRes = await admin.graphql(FULFILLMENT_TRACKING_UPDATE_MUTATION, {
          variables: {
            fulfillmentId:    fulfillment.id,
            trackingInfoInput: { numbers: [], urls: [] },
            notifyCustomer:   false,
          },
        });
        const trackJson   = await trackRes.json();
        const trackErrors = trackJson.data?.fulfillmentTrackingInfoUpdateV2?.userErrors ?? [];
        if (trackErrors.length) {
          console.warn("[cancelFulfillmentInShopify] tracking clear errors:", JSON.stringify(trackErrors));
        }
      } catch (trackErr) {
        console.warn("[cancelFulfillmentInShopify] tracking clear failed:", trackErr?.message);
      }

      // Step B: Cancel fulfillment
      try {
        const cancelRes    = await admin.graphql(FULFILLMENT_CANCEL_MUTATION, {
          variables: { id: fulfillment.id },
        });
        const cancelJson   = await cancelRes.json();
        const cancelErrors = cancelJson.data?.fulfillmentCancel?.userErrors ?? [];
        if (cancelErrors.length) {
          console.warn("[cancelFulfillmentInShopify] cancel errors:", JSON.stringify(cancelErrors));
          allOk = false;
        } else {
          console.log(`[cancelFulfillmentInShopify] Cancelled fulfillment ${fulfillment.id} for order ${shopifyOrderId}`);
        }
      } catch (cancelErr) {
        console.warn("[cancelFulfillmentInShopify] cancel failed:", cancelErr?.message);
        allOk = false;
      }
    }
    return { ok: allOk };
  } catch (err) {
    console.error("[cancelFulfillmentInShopify] Unexpected error:", err?.message);
    return { ok: false };
  }
}

/**
 * Cancels one or more shipments with Leopards Courier and optionally in Shopify.
 *
 * @param {string}  storeId   - Internal store ID
 * @param {string[]} cnNumbers - Leopards CN numbers to cancel
 * @param {object}  [admin]   - Shopify Admin API client. When provided, Shopify
 *                              fulfillments are also cancelled. When absent (e.g.
 *                              called from a webhook context), Shopify writeback is
 *                              skipped.
 */
export async function cancelShipments(storeId, cnNumbers, admin = null, { resetToPending = false } = {}) {
  if (!cnNumbers?.length) {
    return { ok: false, message: "No CN numbers provided." };
  }

  // Only allow cancellation from states the state machine permits
  const cancellable = cancellableStatuses();
  const shipments = await db.shipment.findMany({
    where: {
      storeId,
      cnNumber: { in: cnNumbers },
      status:   { in: cancellable },
    },
  });

  if (!shipments.length) {
    return { ok: false, message: "No cancellable shipments found (they may already be terminal)." };
  }

  const settings = await getSettings(storeId, { decrypt: true });
  const client   = new LeopardApiClient({ storeId, settings });
  const result   = await client.cancelBookedPackets(shipments.map((s) => s.cnNumber));

  const cnErrors = parsePerCnErrors(result?.raw);

  if (!result.ok && Object.keys(cnErrors).length === 0) {
    return { ok: false, message: result.message ?? "Leopards rejected the cancel request." };
  }

  const cancellableShipments = shipments.filter((s) => !cnErrors[s.cnNumber]);
  const failed = shipments
    .filter((s) => cnErrors[s.cnNumber])
    .map((s) => ({ cn: s.cnNumber, reason: cnErrors[s.cnNumber] }));

  if (!cancellableShipments.length) {
    return { ok: false, message: "Leopards rejected every cancellation.", failed };
  }

  const ids = cancellableShipments.map((s) => s.id);
  const now = new Date();

  const cancelData = resetToPending
    ? {
        status:            "PENDING",
        cnNumber:          null,
        slipLink:          null,
        bookedAt:          null,
        cancelledAt:       now,
        lastError:         null,
        shopifySyncStatus: "SYNC_OK",
        ourFulfillmentId:  null,
      }
    : { status: "CANCELLED", cancelledAt: now, lastError: null };

  await db.$transaction([
    db.shipment.updateMany({
      where: { id: { in: ids } },
      data:  cancelData,
    }),
    db.shipmentLog.createMany({
      data: cancellableShipments.map((s) => ({
        shipmentId: s.id,
        eventType:  "CANCELLED",
        fromStatus: s.status,
        toStatus:   resetToPending ? "PENDING" : "CANCELLED",
        message:    resetToPending
          ? "Cancelled via Leopards — reset to pending for re-booking"
          : "Cancelled through Leopards",
      })),
    }),
  ]);

  // ── Shopify fulfillment writeback (non-fatal, parallel) ──────────────────────
  if (admin) {
    const writebackResults = await Promise.allSettled(
      cancellableShipments.map((s) => cancelFulfillmentInShopify(admin, s.shopifyOrderId)),
    );

    const RETRY_15_MIN = new Date(Date.now() + 15 * 60 * 1000);
    const updatePromises = [];
    for (let i = 0; i < cancellableShipments.length; i++) {
      const s      = cancellableShipments[i];
      const result = writebackResults[i];
      const wbOk   = result.status === "fulfilled" && result.value?.ok !== false;
      if (!wbOk) {
        updatePromises.push(
          db.shipment.update({
            where: { id: s.id },
            data:  {
              shopifySyncStatus: "CANCEL_FAILED",
              shopifyRetryCount: (s.shopifyRetryCount ?? 0) + 1,
              shopifyRetryAfter: RETRY_15_MIN,
            },
          }).catch((e) => console.error("[cancelShipments] CANCEL_FAILED update error:", e.message)),
        );
      }
    }
    if (updatePromises.length) await Promise.allSettled(updatePromises);
  }

  return {
    ok:        true,
    message:   failed.length > 0
      ? `${cancellableShipments.length} cancelled, ${failed.length} failed.`
      : `${cancellableShipments.length} shipment(s) cancelled.`,
    cancelled: cancellableShipments.length,
    failed,
  };
}

// ── Status sync ───────────────────────────────────────────────────────────────

export async function refreshShipmentStatuses(storeId, cnNumbers = []) {
  const settings = await getSettings(storeId, { decrypt: true });
  const shipments = await db.shipment.findMany({
    where: {
      storeId,
      cnNumber: cnNumbers.length ? { in: cnNumbers } : { not: null },
      status:   { notIn: TERMINAL_STATUSES },
    },
  });

  if (!shipments.length) {
    return { ok: false, message: "No active shipments need status refresh." };
  }

  const client     = new LeopardApiClient({ storeId, settings });
  const CHUNK_SIZE = 20; // conservative limit per Leopards API call
  const CONCURRENCY = 3;
  const allCns     = shipments.map((s) => s.cnNumber);
  const allPackets = [];
  const chunkErrors = [];

  // Split into chunks, process up to CONCURRENCY chunks in parallel
  const chunks = [];
  for (let i = 0; i < allCns.length; i += CHUNK_SIZE) {
    chunks.push(allCns.slice(i, i + CHUNK_SIZE));
  }

  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = await Promise.allSettled(
      chunks.slice(i, i + CONCURRENCY).map((chunk) => client.trackBookedPacket(chunk)),
    );
    for (const item of batch) {
      if (item.status === "fulfilled" && item.value.ok) {
        allPackets.push(...extractTrackedPackets(item.value));
      } else {
        const msg = item.status === "rejected"
          ? item.reason?.message
          : item.value?.message;
        chunkErrors.push(msg ?? "Leopards API error");
      }
    }
  }

  if (!allPackets.length && chunkErrors.length) {
    return { ok: false, message: chunkErrors[0] };
  }

  const byCn = buildPacketMap(allPackets);
  return applyStatusUpdates(storeId, shipments, byCn);
}

export async function refreshShipmentStatusesByDateRange(storeId, fromDate, toDate) {
  const settings = await getSettings(storeId, { decrypt: true });
  const client   = new LeopardApiClient({ storeId, settings });
  const result   = await client.getBookedPacketLastStatus(fromDate, toDate);

  if (!result.ok) return { ok: false, message: result.message };

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

  return applyStatusUpdates(storeId, shipments, buildPacketMap(packets));
}

// ── Internal helpers ──────────────────────────────────────────────────────────

const VISIBLE_STATUSES = ["BOOKED", "IN_TRANSIT", "DELIVERED", "RETURNED"];

function buildWhere(storeId, status, query) {
  return {
    storeId,
    shopifyDeletedAt: null,
    status: status && VISIBLE_STATUSES.includes(status)
      ? status
      : { in: VISIBLE_STATUSES },
    ...(query
      ? {
          OR: [
            { cnNumber:         { contains: query, mode: "insensitive" } },
            { shopifyOrderName: { contains: query, mode: "insensitive" } },
            { consigneeName:    { contains: query, mode: "insensitive" } },
          ],
        }
      : {}),
  };
}

function parsePerCnErrors(raw) {
  const errSource = raw?.error ?? raw?.data?.error;
  if (!errSource || typeof errSource !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(errSource)) {
    out[String(key)] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return out;
}

function extractTrackedPackets(result) {
  const source =
    result?.data?.packet_list ??
    result?.raw?.packet_list ??
    result?.data ??
    [];
  return Array.isArray(source) ? source : [];
}

function buildPacketMap(packets) {
  return new Map(
    packets.map((p) => [
      String(p.track_number ?? p.tracking_number ?? p.cn_number ?? p.CN ?? ""),
      p,
    ]),
  );
}

async function applyStatusUpdates(storeId, shipments, byCn) {
  const updates    = [];
  const logEntries = [];

  for (const shipment of shipments) {
    // State machine: terminal shipments are immutable
    if (isTerminal(shipment.status)) continue;

    const packet = byCn.get(String(shipment.cnNumber));
    if (!packet) continue;

    const rawStatus  = packet.booked_packet_status ?? packet.status ?? packet.packet_status;
    if (!rawStatus) continue;

    const rawStr    = String(rawStatus);
    const desired   = mapLeopardStatus(rawStr);
    // safeTransition enforces the state machine — no regressions possible
    const nextStatus = safeTransition(shipment.status, desired, `CN ${shipment.cnNumber}`);

    if (
      nextStatus === shipment.status &&
      shipment.leopardStatusRaw === rawStr
    ) continue; // nothing changed

    updates.push({ shipment, nextStatus, rawStr });

    if (nextStatus !== shipment.status) {
      logEntries.push({
        shipmentId: shipment.id,
        eventType:  "STATUS_CHANGE",
        fromStatus: shipment.status,
        toStatus:   nextStatus,
        message:    rawStr,
      });
    }
  }

  if (!updates.length) {
    return { ok: true, message: "All statuses are already up to date." };
  }

  const txOps = updates.map(({ shipment, nextStatus, rawStr }) =>
    db.shipment.update({
      where: { id: shipment.id },
      data:  {
        status:           nextStatus,
        leopardStatusRaw: rawStr,
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
    ok:      true,
    message: `${updates.length} shipment status(es) updated.`,
    updated: updates.length,
  };
}
