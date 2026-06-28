import { randomUUID } from "crypto";
import db from "../db.server";
import { LeopardApiClient } from "../integrations/leopards/client.server";
import {
  normalizePhone,
  parseNonNegativeInt,
  parsePositiveInt,
  validateBookingPayload,
} from "../lib/validation.server";
import { resolveCity, batchResolveCitiesInMemory } from "./city.server";
import { getSettings } from "./settings.server";
import { getOrder } from "./shopify-orders.server";
import { codFromFinancialStatus } from "../lib/cod.server";
import { cancelShipments } from "./shipment.server";

// ── Shopify GraphQL ──────────────────────────────────────────────────────────

const FULFILLMENT_ORDERS_QUERY = `#graphql
  query FulfillmentOrdersForOrder($orderId: ID!) {
    order(id: $orderId) {
      fulfillmentOrders(first: 5) {
        nodes {
          id
          status
          supportedActions { action }
          fulfillments(first: 1) {
            nodes { id }
          }
        }
      }
    }
  }
`;

const FULFILLMENT_CREATE_MUTATION = `#graphql
  mutation FulfillmentCreate($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment {
        id
        status
        trackingInfo { number url company }
      }
      userErrors { field message }
    }
  }
`;

const FULFILLMENT_TRACKING_UPDATE_MUTATION = `#graphql
  mutation FulfillmentTrackingInfoUpdate(
    $fulfillmentId: ID!
    $trackingInfoInput: FulfillmentTrackingInput!
  ) {
    fulfillmentTrackingInfoUpdate(
      fulfillmentId: $fulfillmentId
      trackingInfoInput: $trackingInfoInput
      notifyCustomer: false
    ) {
      fulfillment { id trackingInfo { number url company } }
      userErrors { field message }
    }
  }
`;

// ── Booking lock constants ───────────────────────────────────────────────────

const LOCK_TIMEOUT_MS = 5 * 60 * 1000;

// Exponential retry delay in milliseconds indexed by retry count (0-based)
const RETRY_DELAYS_MS = [
  15 * 60 * 1000,   // 1st failure  → retry after 15 min
  60 * 60 * 1000,   // 2nd failure  → retry after 1 hour
  6 * 60 * 60 * 1000, // 3rd failure → retry after 6 hours
  24 * 60 * 60 * 1000, // 4th failure → retry after 24 hours
];
const MAX_RETRIES = 5; // after this → FAILED_PERMANENTLY

// ── Private helpers ──────────────────────────────────────────────────────────

async function writebackFulfillment(admin, orderId, cnNumber, slipLink) {
  try {
    const foResponse = await admin.graphql(FULFILLMENT_ORDERS_QUERY, {
      variables: { orderId },
    });
    const foJson = await foResponse.json();
    const fulfillmentOrders = foJson.data?.order?.fulfillmentOrders?.nodes ?? [];

    const openFo =
      fulfillmentOrders.find((fo) =>
        fo.supportedActions?.some((a) => a.action === "CREATE_FULFILLMENT"),
      ) ?? fulfillmentOrders.find((fo) => fo.status === "OPEN");

    if (!openFo) {
      // No fulfillment orders at all — digital product, refunded, or not shippable
      if (fulfillmentOrders.length === 0) {
        console.log("[fulfillment writeback] no fulfillment orders — order does not require physical fulfillment", { orderId });
        return { fulfilled: true, fulfillmentId: null };
      }

      const allClosed = fulfillmentOrders.every((fo) => fo.status === "CLOSED");

      if (allClosed) {
        // Already fulfilled — attempt to attach tracking when there is exactly one FO.
        if (fulfillmentOrders.length === 1) {
          const existingFulfillmentId = fulfillmentOrders[0]?.fulfillments?.nodes?.[0]?.id;
          if (existingFulfillmentId) {
            try {
              const updateResponse = await admin.graphql(FULFILLMENT_TRACKING_UPDATE_MUTATION, {
                variables: {
                  fulfillmentId: existingFulfillmentId,
                  trackingInfoInput: {
                    number:  cnNumber,
                    url:     slipLink || `https://leopardscourier.com/track?cn=${cnNumber}`,
                    company: "Leopards Courier",
                  },
                },
              });
              const updateJson   = await updateResponse.json();
              const updateErrors = updateJson.data?.fulfillmentTrackingInfoUpdate?.userErrors ?? [];
              if (updateErrors.length) {
                console.warn("[fulfillment writeback] tracking update userErrors (non-fatal)", {
                  orderId, cnNumber, updateErrors,
                });
              } else {
                return { fulfilled: true, fulfillmentId: existingFulfillmentId };
              }
            } catch (err) {
              console.warn("[fulfillment writeback] tracking update threw (non-fatal)", {
                orderId, error: err.message,
              });
            }
          }
        } else {
          console.log("[fulfillment writeback] multiple CLOSED FOs — skipping tracking update", {
            orderId, foCount: fulfillmentOrders.length,
          });
        }
        return { fulfilled: true, fulfillmentId: null };
      }

      console.warn("[fulfillment writeback] no fulfillable order found", {
        orderId,
        fulfillmentOrders: fulfillmentOrders.map((fo) => ({
          id: fo.id, status: fo.status, supportedActions: fo.supportedActions,
        })),
      });
      return { fulfilled: false, reason: "No open fulfillment order found" };
    }

    const createResponse = await admin.graphql(FULFILLMENT_CREATE_MUTATION, {
      variables: {
        fulfillment: {
          lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: openFo.id }],
          trackingInfo: {
            number:  cnNumber,
            url:     slipLink || `https://leopardscourier.com/track?cn=${cnNumber}`,
            company: "Leopards Courier",
          },
          notifyCustomer: false,
        },
      },
    });

    const createJson = await createResponse.json();
    const errors     = createJson.data?.fulfillmentCreate?.userErrors ?? [];
    if (errors.length) {
      const reason = errors.map((e) => `${e.field}: ${e.message}`).join("; ");
      console.error("[fulfillment writeback] fulfillmentCreate userErrors", { orderId, cnNumber, errors });
      return { fulfilled: false, reason };
    }

    const createdId = createJson.data?.fulfillmentCreate?.fulfillment?.id ?? null;
    return { fulfilled: true, fulfillmentId: createdId };
  } catch (err) {
    console.error("[fulfillment writeback] Unexpected error:", err);
    return { fulfilled: false, reason: err.message };
  }
}

function buildPayload(order, settings, destinationCity, overrides = {}) {
  return {
    booked_packet_weight:         overrides.weightGrams ?? order.weightGrams,
    booked_packet_no_piece:       overrides.noOfPieces ?? 1,
    booked_packet_collect_amount: overrides.codAmount ?? order.codAmount,
    origin_city:                  settings.originCityId,
    destination_city:             destinationCity?.leopardCityId ?? null,
    shipment_id:                  settings.defaultShipmentId || 1,
    shipment_name_eng:            settings.shipperName || "self",
    shipment_email:               settings.shipperEmail || "self",
    shipment_phone:               settings.shipperPhone || "self",
    shipment_address:             settings.shipperAddress || "self",
    consignment_name_eng:         order.customerName,
    consignment_email:            order.customerEmail,
    consignment_phone:            normalizePhone(order.customerPhone),
    consignment_address:          order.address,
    special_instructions:
      overrides.specialInstructions ||
      order.note ||
      settings.defaultSpecialInstructions ||
      "Handle with care",
    booked_packet_order_id: order.name,
  };
}

function extractBookingData(result) {
  const data = Array.isArray(result.data) ? result.data[0] : result.data;
  return {
    trackNumber:         data?.track_number ?? result.raw?.track_number,
    slipLink:            data?.slip_link ?? result.raw?.slip_link,
    bookedPacketOrderId: data?.booked_packet_order_id ?? result.raw?.booked_packet_order_id,
  };
}

function parseOverrides(rawOverrides = {}) {
  if (!rawOverrides) return {};
  return {
    weightGrams:         parsePositiveInt(rawOverrides.weightGrams) ?? undefined,
    noOfPieces:          parsePositiveInt(rawOverrides.noOfPieces) ?? undefined,
    codAmount:           parseNonNegativeInt(rawOverrides.codAmount, null) ?? undefined,
    specialInstructions:
      typeof rawOverrides.specialInstructions === "string"
        ? rawOverrides.specialInstructions.trim() || undefined
        : undefined,
  };
}

// Mark a Shopify writeback as failed with exponential retry scheduling.
async function markWritebackFailed(storeId, shopifyOrderId, currentRetryCount, status = "FULFILLMENT_FAILED") {
  const nextCount = currentRetryCount + 1;
  if (nextCount >= MAX_RETRIES) {
    await db.shipment.updateMany({
      where: { storeId, shopifyOrderId },
      data:  { shopifySyncStatus: "FAILED_PERMANENTLY", shopifyRetryCount: nextCount, shopifyRetryAfter: null },
    }).catch((e) => console.error("[booking] markWritebackFailed (permanent) error:", e.message));
  } else {
    const delayMs = RETRY_DELAYS_MS[Math.min(currentRetryCount, RETRY_DELAYS_MS.length - 1)];
    await db.shipment.updateMany({
      where: { storeId, shopifyOrderId },
      data:  {
        shopifySyncStatus: status,
        shopifyRetryCount: nextCount,
        shopifyRetryAfter: new Date(Date.now() + delayMs),
      },
    }).catch((e) => console.error("[booking] markWritebackFailed error:", e.message));
  }
}

/**
 * Atomically acquires a booking lock.
 * Returns { acquired: true, lockId } or { acquired: false, message }.
 */
async function acquireBookingLock(storeId, orderId, seedData) {
  const lockExpiry = new Date(Date.now() - LOCK_TIMEOUT_MS);
  const lockId     = randomUUID();
  const now        = new Date();

  const lockResult = await db.shipment.updateMany({
    where: {
      storeId,
      shopifyOrderId: orderId,
      status: { in: ["PENDING", "CANCELLED"] },
      OR: [{ bookingLockedAt: null }, { bookingLockedAt: { lt: lockExpiry } }],
    },
    data: { bookingLockedAt: now, bookingLockId: lockId },
  });

  if (lockResult.count > 0) return { acquired: true, lockId };

  const existing = await db.shipment.findUnique({
    where: { storeId_shopifyOrderId: { storeId, shopifyOrderId: orderId } },
  });

  if (existing) {
    if (!["PENDING", "CANCELLED"].includes(existing.status)) {
      return { acquired: false, message: "This order already has an active shipment." };
    }
    return { acquired: false, message: "Booking already in progress. Please try again in a moment." };
  }

  // No record yet — create with lock held
  try {
    await db.shipment.create({
      data: {
        storeId,
        shopifyOrderId:   orderId,
        shopifyOrderName: seedData.name,
        status:           "PENDING",
        codAmount:        0,
        weightGrams:      seedData.defaultWeightGrams,
        consigneeName:    seedData.customerName || "Unknown",
        consigneePhone:   seedData.customerPhone || "",
        consigneeAddress: seedData.address || "",
        bookingLockedAt:  now,
        bookingLockId:    lockId,
      },
    });
    return { acquired: true, lockId };
  } catch (createErr) {
    if (createErr.code === "P2002") {
      const retryLock = await db.shipment.updateMany({
        where: {
          storeId,
          shopifyOrderId: orderId,
          status: { in: ["PENDING", "CANCELLED"] },
          OR: [{ bookingLockedAt: null }, { bookingLockedAt: { lt: lockExpiry } }],
        },
        data: { bookingLockedAt: now, bookingLockId: lockId },
      });
      if (retryLock.count > 0) return { acquired: true, lockId };
      return { acquired: false, message: "Booking already in progress. Please try again in a moment." };
    }
    throw createErr;
  }
}

// Only the process that owns the lockId can release it.
async function releaseLock(storeId, orderId, lockId) {
  await db.shipment
    .updateMany({
      where: { storeId, shopifyOrderId: orderId, bookingLockId: lockId },
      data:  { bookingLockedAt: null, bookingLockId: null },
    })
    .catch((err) => console.error("[booking] releaseLock failed for", orderId, ":", err.message));
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function bookOrder({ admin, storeId, orderId, overrides: rawOverrides = {} }) {
  const settings = await getSettings(storeId, { decrypt: true });

  if (!settings.leopardApiKey || !settings.leopardApiPassword) {
    return { ok: false, message: "Save Leopards credentials before booking." };
  }
  if (!settings.originCityId) {
    return { ok: false, message: "Origin city not set. Configure it in Settings before booking." };
  }

  const overrides = parseOverrides(rawOverrides);

  // Load the existing Shipment to get financialStatus/totalPrice for COD pre-fill.
  // If the Shipment doesn't exist yet (webhook delay), fall back to what getOrder returns.
  const existingShipment = await db.shipment.findUnique({
    where: { storeId_shopifyOrderId: { storeId, shopifyOrderId: orderId } },
    select: { financialStatus: true, totalPrice: true, shopifyRetryCount: true },
  });
  const defaultCodAmount = existingShipment
    ? codFromFinancialStatus(existingShipment.financialStatus, existingShipment.totalPrice)
    : null;

  const order = await getOrder({ admin, storeId, orderId, defaultWeightGrams: settings.defaultWeightGrams });
  if (!order) return { ok: false, message: "Shopify order was not found." };

  // Override COD: merchant form input > Shipment-derived default > Shopify-derived default
  const overridesWithCod = {
    ...overrides,
    codAmount: overrides.codAmount ?? defaultCodAmount ?? order.codAmount,
  };

  const lock = await acquireBookingLock(storeId, orderId, {
    name:               order.name,
    defaultWeightGrams: settings.defaultWeightGrams,
    customerName:       order.customerName,
    customerPhone:      order.customerPhone,
    address:            order.address,
  });

  if (!lock.acquired) return { ok: false, message: lock.message };

  try {
    const destinationCity = await resolveCity(storeId, order.destinationCity);

    if (!destinationCity && order.destinationCity) {
      await releaseLock(storeId, orderId, lock.lockId);
      return {
        ok: false,
        message: `Destination city "${order.destinationCity}" not found in city list. Go to Settings → Refresh Cities and try again.`,
      };
    }

    const payload    = buildPayload(order, settings, destinationCity, overridesWithCod);
    const validation = validateBookingPayload(payload);

    if (!validation.ok) {
      await releaseLock(storeId, orderId, lock.lockId);
      return { ok: false, message: "Fix the order data before booking.", fieldErrors: validation.errors };
    }

    const client = new LeopardApiClient({ storeId, settings });
    console.log(
      `[bookOrder] ${order.name} | COD: ${payload.booked_packet_collect_amount} | city: ${payload.destination_city} | weight: ${payload.booked_packet_weight}g`,
    );
    const result = await client.bookPacket(payload);

    if (!result.ok) {
      await db.shipment.updateMany({
        where: { storeId, shopifyOrderId: orderId },
        data:  { lastError: result.message?.slice(0, 1000), bookingLockedAt: null, bookingLockId: null },
      });
      return { ok: false, message: result.message, fieldErrors: result.fieldErrors };
    }

    const booked = extractBookingData(result);

    // ── Atomic DB commit ───────────────────────────────────────────────────────
    const shipment = await db.$transaction(async (tx) => {
      const s = await tx.shipment.update({
        where: { storeId_shopifyOrderId: { storeId, shopifyOrderId: orderId } },
        data: {
          cnNumber:            booked.trackNumber,
          slipLink:            booked.slipLink,
          bookedPacketOrderId: booked.bookedPacketOrderId || order.name,
          status:              "BOOKED",
          codAmount:           payload.booked_packet_collect_amount,
          weightGrams:         payload.booked_packet_weight,
          noOfPieces:          payload.booked_packet_no_piece,
          originCityId:        settings.originCityId,
          destinationCityId:   destinationCity?.leopardCityId ?? null,
          consigneeName:       order.customerName,
          consigneePhone:      order.customerPhone,
          consigneeAddress:    order.address,
          cancelledAt:         null,
          lastError:           null,
          bookingLockedAt:     null,
          bookingLockId:       null,
          bookedAt:            new Date(),
          shopifySyncStatus:   "SYNC_OK",
          leopardSyncStatus:   "SYNC_OK",
        },
      });
      await tx.shipmentLog.create({
        data: {
          shipmentId: s.id,
          eventType:  "BOOKED",
          toStatus:   "BOOKED",
          message:    `Booked with CN ${booked.trackNumber}`,
        },
      });
      return s;
    });

    // ── Check pendingCancellation (booking + cancel race) ──────────────────────
    // If a Shopify cancel webhook arrived while the lock was held, cancel immediately.
    const fresh = await db.shipment.findUnique({
      where: { id: shipment.id },
      select: { pendingCancellation: true },
    });
    if (fresh?.pendingCancellation) {
      await db.shipmentLog.create({
        data: {
          shipmentId: shipment.id,
          eventType:  "PENDING_CANCELLATION_EXECUTED",
          fromStatus: "BOOKED",
          toStatus:   "CANCELLED",
          message:    "Reversing booking — Shopify order was cancelled while booking was in flight.",
        },
      });
      try {
        await cancelShipments(storeId, [booked.trackNumber], admin);
      } catch (cancelErr) {
        console.error("[bookOrder] pendingCancellation auto-cancel failed:", cancelErr.message);
      }
      return { ok: false, message: `${order.name} was cancelled in Shopify — booking has been reversed.` };
    }

    // ── Shopify writeback ──────────────────────────────────────────────────────
    if (booked.trackNumber && settings.fulfillmentWritebackEnabled) {
      const wbResult = await writebackFulfillment(admin, order.id, booked.trackNumber, booked.slipLink);
      if (wbResult.fulfilled) {
        const updateData = { shopifySyncStatus: "SYNC_OK" };
        if (wbResult.fulfillmentId) {
          updateData.ourFulfillmentId = wbResult.fulfillmentId;
        }
        await db.shipment.updateMany({ where: { storeId, shopifyOrderId: orderId }, data: updateData })
          .catch((e) => console.error("[bookOrder] ourFulfillmentId update failed:", e.message));
        await db.shipmentLog.create({
          data: {
            shipmentId: shipment.id,
            eventType:  "SHOPIFY_FULFILLMENT_CREATED",
            fromStatus: "BOOKED",
            toStatus:   "BOOKED",
            message:    `Shopify fulfillment created (${wbResult.fulfillmentId ?? "ID unknown"})`,
          },
        }).catch(() => {});
      } else {
        await markWritebackFailed(storeId, orderId, existingShipment?.shopifyRetryCount ?? 0);
        await db.shipmentLog.create({
          data: {
            shipmentId: shipment.id,
            eventType:  "ERROR",
            fromStatus: "BOOKED",
            toStatus:   "BOOKED",
            message:    `Shopify writeback failed: ${wbResult.reason ?? "unknown"}. Scheduled for retry.`,
          },
        }).catch(() => {});
      }
    }

    return {
      ok:       true,
      message:  `${order.name} booked with CN ${booked.trackNumber}`,
      cnNumber: booked.trackNumber,
      slipLink: booked.slipLink,
    };
  } catch (err) {
    await releaseLock(storeId, orderId, lock.lockId);
    await db.shipment
      .updateMany({
        where: { storeId, shopifyOrderId: orderId },
        data:  { lastError: err.message?.slice(0, 500), bookingLockedAt: null, bookingLockId: null },
      })
      .catch(() => {});
    throw err;
  }
}

export async function bookOrdersBatch({ admin, storeId, orderIds }) {
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return { ok: false, message: "Select at least one order to book." };
  }
  const settings = await getSettings(storeId, { decrypt: true });
  if (!settings.leopardApiKey || !settings.leopardApiPassword) {
    return { ok: false, message: "Save Leopards credentials before booking." };
  }
  if (!settings.originCityId) {
    return { ok: false, message: "Origin city not set. Configure it in Settings." };
  }

  const results = [];

  // ── 1. Filter already-booked orders ──────────────────────────────────────────
  const existingShipments = await db.shipment.findMany({
    where: { storeId, shopifyOrderId: { in: orderIds }, status: { not: "CANCELLED" } },
    select: { shopifyOrderId: true, shopifyOrderName: true, status: true,
              financialStatus: true, totalPrice: true, shopifyRetryCount: true },
  });
  const alreadyActiveByOrderId = new Map(existingShipments.map((s) => [s.shopifyOrderId, s]));

  for (const [orderId, existing] of alreadyActiveByOrderId) {
    if (existing.status !== "PENDING") {
      results.push({ orderId, orderName: existing.shopifyOrderName, ok: false, message: "Already booked." });
    }
  }

  const toFetch = orderIds.filter(
    (id) => !alreadyActiveByOrderId.has(id) || alreadyActiveByOrderId.get(id)?.status === "PENDING",
  );

  if (!toFetch.length) {
    return { ok: false, message: "All selected orders are already booked.", results };
  }

  // ── 2. Acquire batch booking locks using a shared batch UUID ─────────────────
  const batchLockId = randomUUID();
  const lockTs      = new Date();
  const lockExpiry  = new Date(Date.now() - LOCK_TIMEOUT_MS);

  const existingRecordIds = new Set(
    (await db.shipment.findMany({
      where: { storeId, shopifyOrderId: { in: toFetch } },
      select: { shopifyOrderId: true },
    })).map((s) => s.shopifyOrderId),
  );
  const noRecordIds = toFetch.filter((id) => !existingRecordIds.has(id));

  if (noRecordIds.length > 0) {
    await db.shipment.createMany({
      data: noRecordIds.map((id) => ({
        storeId,
        shopifyOrderId:   id,
        shopifyOrderName: `#${id.split("/").pop()}`,
        weightGrams:      settings.defaultWeightGrams,
        consigneeName:    "Unknown",
        consigneePhone:   "",
        consigneeAddress: "",
        bookingLockedAt:  lockTs,
        bookingLockId:    batchLockId,
      })),
      skipDuplicates: true,
    });
  }

  await db.shipment.updateMany({
    where: {
      storeId,
      shopifyOrderId: { in: toFetch },
      status: { in: ["PENDING", "CANCELLED"] },
      OR: [{ bookingLockedAt: null }, { bookingLockedAt: { lt: lockExpiry } }],
    },
    data: { bookingLockedAt: lockTs, bookingLockId: batchLockId },
  });

  const lockedRecords = await db.shipment.findMany({
    where: { storeId, shopifyOrderId: { in: toFetch }, bookingLockId: batchLockId },
    select: { shopifyOrderId: true },
  });
  const lockedIds = new Set(lockedRecords.map((s) => s.shopifyOrderId));

  for (const orderId of toFetch) {
    if (!lockedIds.has(orderId)) {
      results.push({ orderId, orderName: orderId, ok: false, message: "Booking already in progress for this order." });
    }
  }

  const toBatch = toFetch.filter((id) => lockedIds.has(id));
  if (!toBatch.length) {
    return { ok: false, message: "No bookable orders available.", results };
  }

  // ── 3. Fetch Shopify orders + resolve cities in parallel ──────────────────────
  const fetchedOrders = await Promise.all(
    toBatch.map((orderId) =>
      getOrder({ admin, storeId, orderId, defaultWeightGrams: settings.defaultWeightGrams }),
    ),
  );

  const cityNames = fetchedOrders.map((o) => o?.destinationCity ?? "").filter(Boolean);
  const cityMap   = await batchResolveCitiesInMemory(storeId, cityNames);

  const packetsToBook = [];
  const orderContext  = [];

  for (let i = 0; i < toBatch.length; i++) {
    const orderId = toBatch[i];
    const order   = fetchedOrders[i];

    if (!order) {
      await db.shipment.updateMany({
        where: { storeId, shopifyOrderId: orderId },
        data:  { bookingLockedAt: null, bookingLockId: null },
      }).catch(() => {});
      results.push({ orderId, orderName: orderId, ok: false, message: "Order not found in Shopify." });
      continue;
    }

    const destinationCity = cityMap.get(order.destinationCity) ?? null;

    // Use Shipment's financialStatus/totalPrice for COD (already synced from Shopify webhooks)
    const shipmentRecord  = alreadyActiveByOrderId.get(orderId);
    const codAmount       = shipmentRecord
      ? codFromFinancialStatus(shipmentRecord.financialStatus, shipmentRecord.totalPrice)
      : order.codAmount;

    const payload    = buildPayload(order, settings, destinationCity, { codAmount });
    const validation = validateBookingPayload(payload);

    if (!validation.ok) {
      await db.shipment.updateMany({
        where: { storeId, shopifyOrderId: orderId },
        data:  { bookingLockedAt: null, bookingLockId: null },
      }).catch(() => {});
      results.push({
        orderId,
        orderName:   order.name,
        ok:          false,
        message:     "Invalid order data: " + Object.keys(validation.errors).join(", "),
        fieldErrors: validation.errors,
      });
      continue;
    }

    packetsToBook.push(payload);
    orderContext.push({ order, destinationCity, orderId, shipmentRecord });
  }

  if (!packetsToBook.length) {
    return { ok: false, message: "No valid orders to book.", results };
  }

  // ── 4. Call Leopards API in chunks of 100 ────────────────────────────────────
  const BATCH_SIZE = 100;
  const client = new LeopardApiClient({ storeId, settings });
  const writebackTasks = [];

  for (let ci = 0; ci < packetsToBook.length; ci += BATCH_SIZE) {
    const chunkPackets  = packetsToBook.slice(ci, ci + BATCH_SIZE);
    const chunkContext  = orderContext.slice(ci, ci + BATCH_SIZE);
    const apiResult     = await client.batchBookPacket(chunkPackets);
    const dataArr       = Array.isArray(apiResult.data)
      ? apiResult.data
      : Array.isArray(apiResult.raw?.data)
        ? apiResult.raw.data
        : [];

    if (!apiResult.ok && !dataArr.length) {
      for (const { order, orderId } of chunkContext) {
        await db.shipment.updateMany({
          where: { storeId, shopifyOrderId: orderId },
          data:  { lastError: apiResult.message?.slice(0, 1000), bookingLockedAt: null, bookingLockId: null },
        }).catch(() => {});
        results.push({ orderId, orderName: order.name, ok: false, message: apiResult.message ?? "Batch booking failed." });
      }
      continue;
    }

    const byOrderName = new Map();
    for (const item of dataArr) {
      const key = item?.booked_packet_order_id ? String(item.booked_packet_order_id) : null;
      if (key) byOrderName.set(key, item);
    }

    for (let i = 0; i < chunkContext.length; i++) {
      const { order, destinationCity, orderId, shipmentRecord } = chunkContext[i];
      const item        = byOrderName.get(order.name) ?? (byOrderName.size === 0 ? dataArr[i] : undefined);
      const trackNumber = item?.track_number;
      const slipLink    = item?.slip_link;

      if (!trackNumber) {
        const rawError  = item?.error ?? apiResult.raw?.error?.[`bookPacket - ${i}`] ?? "Leopards rejected this packet.";
        const errMsg    = typeof rawError === "string" ? rawError : JSON.stringify(rawError);
        await db.shipment.updateMany({
          where: { storeId, shopifyOrderId: orderId },
          data:  { lastError: errMsg.slice(0, 1000), bookingLockedAt: null, bookingLockId: null },
        }).catch(() => {});
        results.push({ orderId, orderName: order.name, ok: false, message: errMsg });
        continue;
      }

      try {
        const shipment = await db.$transaction(async (tx) => {
          const s = await tx.shipment.update({
            where: { storeId_shopifyOrderId: { storeId, shopifyOrderId: orderId } },
            data: {
              cnNumber:            trackNumber,
              slipLink:            slipLink ?? null,
              bookedPacketOrderId: item?.booked_packet_order_id || order.name,
              shopifyOrderName:    order.name,
              status:              "BOOKED",
              codAmount:           chunkPackets[i].booked_packet_collect_amount,
              weightGrams:         chunkPackets[i].booked_packet_weight,
              originCityId:        settings.originCityId,
              destinationCityId:   destinationCity?.leopardCityId ?? null,
              consigneeName:       order.customerName,
              consigneePhone:      order.customerPhone,
              consigneeAddress:    order.address,
              cancelledAt:         null,
              lastError:           null,
              bookingLockedAt:     null,
              bookingLockId:       null,
              bookedAt:            new Date(),
              shopifySyncStatus:   "SYNC_OK",
              leopardSyncStatus:   "SYNC_OK",
            },
          });
          await tx.shipmentLog.create({
            data: {
              shipmentId: s.id,
              eventType:  "BOOKED",
              toStatus:   "BOOKED",
              message:    `Batch booked with CN ${trackNumber}`,
            },
          });
          return s;
        });

        // Check pendingCancellation after commit
        const fresh = await db.shipment.findUnique({
          where: { id: shipment.id },
          select: { pendingCancellation: true },
        });
        if (fresh?.pendingCancellation) {
          await db.shipmentLog.create({
            data: {
              shipmentId: shipment.id,
              eventType:  "PENDING_CANCELLATION_EXECUTED",
              fromStatus: "BOOKED",
              toStatus:   "CANCELLED",
              message:    "Reversing batch booking — Shopify order was cancelled while booking was in flight.",
            },
          }).catch(() => {});
          cancelShipments(storeId, [trackNumber], admin).catch((e) =>
            console.error("[bookOrdersBatch] pendingCancellation auto-cancel failed:", e.message),
          );
          results.push({ orderId, orderName: order.name, ok: false, message: "Cancelled in Shopify while booking was in flight — reversed." });
          continue;
        }

        if (trackNumber && settings.fulfillmentWritebackEnabled) {
          const capturedOrderId = orderId;
          const retryCount      = shipmentRecord?.shopifyRetryCount ?? 0;
          writebackTasks.push(async () => {
            const wbResult = await writebackFulfillment(admin, order.id, trackNumber, slipLink);
            if (wbResult.fulfilled) {
              const updateData = { shopifySyncStatus: "SYNC_OK" };
              if (wbResult.fulfillmentId) {
                updateData.ourFulfillmentId  = wbResult.fulfillmentId;
                    }
              await db.shipment.updateMany({ where: { storeId, shopifyOrderId: capturedOrderId }, data: updateData })
                .catch((e) => console.error("[batch writeback] ourFulfillmentId update failed:", e.message));
            } else {
              await markWritebackFailed(storeId, capturedOrderId, retryCount);
            }
          });
        }

        results.push({ orderId, orderName: order.name, cnNumber: trackNumber, ok: true, message: `Booked with CN ${trackNumber}` });
      } catch (dbErr) {
        console.error(`[bookOrdersBatch] DB commit failed for ${order.name}:`, dbErr);
        await db.shipment.updateMany({
          where: { storeId, shopifyOrderId: orderId },
          data:  { bookingLockedAt: null, bookingLockId: null },
        }).catch(() => {});
        results.push({ orderId, orderName: order.name, ok: false, message: "Failed to save booking. The CN may have been created — check with Leopards." });
      }
    }
  }

  if (writebackTasks.length) {
    await Promise.allSettled(writebackTasks.map((fn) => fn()));
  }

  const successes = results.filter((r) => r.ok).length;
  const failures  = results.length - successes;

  return {
    ok:      successes > 0,
    message: failures === 0
      ? `${successes} order(s) booked successfully.`
      : `${successes} booked, ${failures} failed.`,
    results,
  };
}

// Restores a Shopify fulfillment that was removed externally while our CN is still active.
export async function restoreBrokenFulfillment({ admin, storeId, orderId }) {
  const shipment = await db.shipment.findUnique({
    where: { storeId_shopifyOrderId: { storeId, shopifyOrderId: orderId } },
    select: { id: true, cnNumber: true, slipLink: true },
  });
  if (!shipment?.cnNumber) {
    return { ok: false, message: "No CN number found for this order." };
  }

  const result = await writebackFulfillment(admin, orderId, shipment.cnNumber, shipment.slipLink);

  if (result.fulfilled) {
    const updateData = {
      shopifySyncBroken: false,
      shopifySyncStatus: "SYNC_OK",
      shopifyRetryCount: 0,
      shopifyRetryAfter: null,
    };
    if (result.fulfillmentId) updateData.ourFulfillmentId = result.fulfillmentId;
    await db.shipment.updateMany({ where: { storeId, shopifyOrderId: orderId }, data: updateData })
      .catch((e) => console.error("[restoreBrokenFulfillment] update error:", e.message));
    await db.shipmentLog.create({
      data: {
        shipmentId: shipment.id,
        eventType:  "SYNC_FIXED",
        fromStatus: "BOOKED",
        toStatus:   "BOOKED",
        message:    "Shopify fulfillment restored by merchant action.",
      },
    }).catch(() => {});
    return { ok: true, message: "Shopify fulfillment restored successfully." };
  }

  return { ok: false, message: result.reason ?? "Failed to restore Shopify fulfillment." };
}

export async function retryWriteback({ admin, storeId, orderId }) {
  const shipment = await db.shipment.findUnique({
    where: { storeId_shopifyOrderId: { storeId, shopifyOrderId: orderId } },
    select: { cnNumber: true, slipLink: true, shopifySyncStatus: true, shopifyRetryCount: true, id: true },
  });

  if (!shipment?.cnNumber) {
    return { ok: false, message: "No CN number found for this order." };
  }
  if (shipment.shopifySyncStatus === "SYNC_OK") {
    return { ok: true, message: "Sync already succeeded — nothing to retry." };
  }

  const foResponse = await admin.graphql(
    `#graphql
      query CheckFulfillmentState($id: ID!) {
        order(id: $id) {
          fulfillmentOrders(first: 5) {
            nodes { id status supportedActions { action } }
          }
        }
      }
    `,
    { variables: { id: orderId } },
  );
  const foJson            = await foResponse.json();
  const fulfillmentOrders = foJson.data?.order?.fulfillmentOrders?.nodes ?? [];
  const alreadyFulfilled  =
    fulfillmentOrders.length > 0 && fulfillmentOrders.every((fo) => fo.status === "CLOSED");

  if (alreadyFulfilled) {
    await db.shipment.updateMany({
      where: { storeId, shopifyOrderId: orderId },
      data:  { shopifySyncStatus: "SYNC_OK", shopifyRetryCount: 0, shopifyRetryAfter: null },
    }).catch((e) => console.error("[retryWriteback] flag clear failed:", e.message));
    return { ok: true, message: "Shopify fulfillment already exists — sync flag cleared." };
  }

  const hasOpenFo = fulfillmentOrders.some((fo) =>
    fo.supportedActions?.some((a) => a.action === "CREATE_FULFILLMENT"),
  );
  if (!hasOpenFo) {
    return { ok: false, message: "No open fulfillment order found in Shopify for this order." };
  }

  await db.shipmentLog.create({
    data: {
      shipmentId: shipment.id,
      eventType:  "SYNC_RETRY",
      fromStatus: "BOOKED",
      toStatus:   "BOOKED",
      message:    `Manual retry of Shopify writeback (attempt ${shipment.shopifyRetryCount + 1})`,
    },
  }).catch(() => {});

  const result = await writebackFulfillment(admin, orderId, shipment.cnNumber, shipment.slipLink);

  if (result.fulfilled) {
    const updateData = { shopifySyncStatus: "SYNC_OK", shopifyRetryCount: 0, shopifyRetryAfter: null };
    if (result.fulfillmentId) {
      updateData.ourFulfillmentId  = result.fulfillmentId;
      updateData.fulfillmentSource = "OUR_APP";
    }
    await db.shipment.updateMany({ where: { storeId, shopifyOrderId: orderId }, data: updateData })
      .catch((e) => console.error("[retryWriteback] flag clear failed:", e.message));
    await db.shipmentLog.create({
      data: {
        shipmentId: shipment.id,
        eventType:  "SYNC_FIXED",
        fromStatus: "BOOKED",
        toStatus:   "BOOKED",
        message:    "Shopify writeback retry succeeded.",
      },
    }).catch(() => {});
    return { ok: true, message: "Shopify sync succeeded." };
  }

  await markWritebackFailed(storeId, orderId, shipment.shopifyRetryCount, "FULFILLMENT_FAILED");
  return {
    ok:      false,
    message: result.reason
      ? `Shopify sync failed: ${result.reason}`
      : "Shopify sync failed again. Check server logs for the specific error.",
  };
}
