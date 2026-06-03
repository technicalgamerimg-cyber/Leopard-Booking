import db from "../db.server";
import { LeopardApiClient } from "../integrations/leopards/client.server";
import {
  normalizePhone,
  parseNonNegativeInt,
  parsePositiveInt,
  validateBookingPayload,
} from "../lib/validation.server";
import { resolveCity, batchResolveCitiesInMemory } from "./city.server";
import { getSettings, getCodKeywords } from "./settings.server";
import { getOrder } from "./shopify-orders.server";
import { canTransition } from "../lib/shipment-state-machine.server";

// ── Shopify GraphQL ──────────────────────────────────────────────────────────

const FULFILLMENT_ORDERS_QUERY = `#graphql
  query FulfillmentOrdersForOrder($orderId: ID!) {
    order(id: $orderId) {
      fulfillmentOrders(first: 5) {
        nodes {
          id
          status
          supportedActions { action }
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

const ORDER_UPDATE_MUTATION = `#graphql
  mutation OrderUpdate($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id note }
      userErrors { field message }
    }
  }
`;

// ── Booking lock constants ───────────────────────────────────────────────────

const LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes; stale locks auto-expire

// ── Private helpers ──────────────────────────────────────────────────────────

async function writeOrderNote(admin, orderId, cnNumber, existingNote = "") {
  try {
    const cnLine = `Leopards CN: ${cnNumber}`;
    const updatedNote =
      existingNote && /Leopards CN:/i.test(existingNote)
        ? existingNote.replace(/Leopards CN:.*$/im, cnLine)
        : existingNote
          ? `${existingNote.trim()}\n${cnLine}`
          : cnLine;

    const response = await admin.graphql(ORDER_UPDATE_MUTATION, {
      variables: { input: { id: orderId, note: updatedNote } },
    });
    const json = await response.json();
    const errors = json.data?.orderUpdate?.userErrors ?? [];
    if (errors.length) {
      console.error("[order note] orderUpdate errors:", JSON.stringify(errors));
    }
  } catch (err) {
    console.error("[order note] Unexpected error:", err);
  }
}

async function writebackFulfillment(admin, orderId, cnNumber, slipLink, existingNote = "") {
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
      console.warn(`[fulfillment writeback] No fulfillable order for ${orderId}`);
      return { fulfilled: false };
    }

    const createResponse = await admin.graphql(FULFILLMENT_CREATE_MUTATION, {
      variables: {
        fulfillment: {
          lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: openFo.id }],
          trackingInfo: {
            number: cnNumber,
            url: slipLink || `https://leopardscourier.com/track?cn=${cnNumber}`,
            company: "Leopards Courier",
          },
          notifyCustomer: false,
        },
      },
    });

    const createJson = await createResponse.json();
    const errors = createJson.data?.fulfillmentCreate?.userErrors ?? [];
    if (errors.length) {
      console.error("[fulfillment writeback] fulfillmentCreate errors:", JSON.stringify(errors));
      return { fulfilled: false };
    }

    await writeOrderNote(admin, orderId, cnNumber, existingNote);
    return { fulfilled: true };
  } catch (err) {
    console.error("[fulfillment writeback] Unexpected error:", err);
    return { fulfilled: false };
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

/**
 * Atomically acquires a booking lock on a shipment record.
 *
 * Strategy:
 *  1. Try updateMany on existing PENDING/CANCELLED record with null/expired lock.
 *  2. If 0 rows updated → check why (already booked vs locked vs missing).
 *  3. If missing → create the record with the lock held.
 *  4. Returns { acquired: true } or { acquired: false, message }
 */
async function acquireBookingLock(storeId, orderId, seedData) {
  const lockExpiry = new Date(Date.now() - LOCK_TIMEOUT_MS);
  const now = new Date();

  // Attempt to lock an existing record
  const lockResult = await db.shipment.updateMany({
    where: {
      storeId,
      shopifyOrderId: orderId,
      status: { in: ["PENDING", "CANCELLED"] },
      OR: [{ bookingLockedAt: null }, { bookingLockedAt: { lt: lockExpiry } }],
    },
    data: { bookingLockedAt: now },
  });

  if (lockResult.count > 0) return { acquired: true };

  // Diagnose why lock was not acquired
  const existing = await db.shipment.findUnique({
    where: { storeId_shopifyOrderId: { storeId, shopifyOrderId: orderId } },
  });

  if (existing) {
    if (!["PENDING", "CANCELLED"].includes(existing.status)) {
      return {
        acquired: false,
        message: "This order already has an active shipment.",
      };
    }
    // PENDING/CANCELLED but lock is fresh → another request is in-flight
    return {
      acquired: false,
      message: "Booking already in progress. Please try again in a moment.",
    };
  }

  // No record exists yet (order/create webhook may not have fired).
  // Create with lock held — if two requests race, exactly one wins via unique constraint.
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
      },
    });
    return { acquired: true };
  } catch (createErr) {
    if (createErr.code === "P2002") {
      // Unique constraint: another concurrent request just created the record.
      // Try to lock it.
      const retryLock = await db.shipment.updateMany({
        where: {
          storeId,
          shopifyOrderId: orderId,
          status: { in: ["PENDING", "CANCELLED"] },
          OR: [{ bookingLockedAt: null }, { bookingLockedAt: { lt: lockExpiry } }],
        },
        data: { bookingLockedAt: now },
      });
      if (retryLock.count > 0) return { acquired: true };
      return {
        acquired: false,
        message: "Booking already in progress. Please try again in a moment.",
      };
    }
    throw createErr;
  }
}

async function releaseLock(storeId, orderId) {
  await db.shipment
    .updateMany({
      where: { storeId, shopifyOrderId: orderId },
      data: { bookingLockedAt: null },
    })
    .catch(() => {});
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function bookOrder({ admin, storeId, orderId, overrides: rawOverrides = {} }) {
  const settings = await getSettings(storeId, { decrypt: true });

  if (!settings.leopardApiKey || !settings.leopardApiPassword) {
    return { ok: false, message: "Save Leopards credentials before booking." };
  }

  if (!settings.originCityId) {
    return {
      ok: false,
      message: "Origin city not set. Configure it in Settings before booking.",
    };
  }

  const codKeywords = getCodKeywords(settings);
  const overrides = parseOverrides(rawOverrides);
  const order = await getOrder({
    admin,
    storeId,
    orderId,
    defaultWeightGrams: settings.defaultWeightGrams,
    codKeywords,
  });
  if (!order) return { ok: false, message: "Shopify order was not found." };

  // ── Acquire booking lock (prevents double-booking under double-click / retry) ──
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
    const payload = buildPayload(order, settings, destinationCity, overrides);
    const validation = validateBookingPayload(payload);

    if (!validation.ok) {
      await releaseLock(storeId, orderId);
      return { ok: false, message: "Fix the order data before booking.", fieldErrors: validation.errors };
    }

    const client = new LeopardApiClient({ storeId, settings });
    console.log(
      `[bookOrder] ${order.name} | COD: ${payload.booked_packet_collect_amount} | city: ${payload.destination_city} | weight: ${payload.booked_packet_weight}g`,
    );
    const result = await client.bookPacket(payload);

    if (!result.ok) {
      // Record the error on the shipment and release the lock
      await db.shipment.updateMany({
        where: { storeId, shopifyOrderId: orderId },
        data: { lastError: result.message?.slice(0, 1000), bookingLockedAt: null },
      });
      return result;
    }

    const booked = extractBookingData(result);

    // ── Atomic DB commit: BOOKED state + log + lock release ──
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
          bookingLockedAt:     null, // release
          bookedAt:            new Date(),
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

    // ── Shopify writeback (outside DB transaction — non-fatal if it fails) ──
    if (booked.trackNumber && settings.fulfillmentWritebackEnabled) {
      await writebackFulfillment(admin, order.id, booked.trackNumber, booked.slipLink, order.note);
    }

    return {
      ok:       true,
      message:  `${order.name} booked with CN ${booked.trackNumber}`,
      cnNumber: booked.trackNumber,
      slipLink: booked.slipLink,
    };
  } catch (err) {
    // Always release lock on unexpected error so the operator can retry
    await releaseLock(storeId, orderId);
    await db.shipment
      .updateMany({
        where: { storeId, shopifyOrderId: orderId },
        data: { lastError: err.message?.slice(0, 500), bookingLockedAt: null },
      })
      .catch(() => {});
    throw err;
  }
}

export async function bookOrdersBatch({ admin, storeId, orderIds }) {
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return { ok: false, message: "Select at least one order to book." };
  }
  if (orderIds.length > 100) {
    return { ok: false, message: "Maximum 100 orders per batch. Split into smaller groups." };
  }

  const settings = await getSettings(storeId, { decrypt: true });
  if (!settings.leopardApiKey || !settings.leopardApiPassword) {
    return { ok: false, message: "Save Leopards credentials before booking." };
  }
  if (!settings.originCityId) {
    return { ok: false, message: "Origin city not set. Configure it in Settings." };
  }

  const codKeywords = getCodKeywords(settings);
  const results = [];

  // ── 1. Filter already-booked orders ─────────────────────────────────────────
  const existingShipments = await db.shipment.findMany({
    where: { storeId, shopifyOrderId: { in: orderIds }, status: { not: "CANCELLED" } },
    select: { shopifyOrderId: true, shopifyOrderName: true, status: true },
  });
  const alreadyActiveByOrderId = new Map(existingShipments.map((s) => [s.shopifyOrderId, s]));

  for (const [orderId, existing] of alreadyActiveByOrderId) {
    if (existing.status !== "PENDING") {
      results.push({
        orderId,
        orderName: existing.shopifyOrderName,
        ok:      false,
        message: "Already booked.",
      });
    }
  }

  const toFetch = orderIds.filter(
    (id) => !alreadyActiveByOrderId.has(id) || alreadyActiveByOrderId.get(id)?.status === "PENDING",
  );

  if (!toFetch.length) {
    return { ok: false, message: "All selected orders are already booked.", results };
  }

  // ── 2. Acquire booking locks for all eligible orders atomically ──────────────
  const lockTs = new Date();
  const lockExpiry = new Date(Date.now() - LOCK_TIMEOUT_MS);

  await db.shipment.updateMany({
    where: {
      storeId,
      shopifyOrderId: { in: toFetch },
      status: { in: ["PENDING", "CANCELLED"] },
      OR: [{ bookingLockedAt: null }, { bookingLockedAt: { lt: lockExpiry } }],
    },
    data: { bookingLockedAt: lockTs },
  });

  // Determine which orders we actually locked (exact timestamp match)
  const lockedRecords = await db.shipment.findMany({
    where: { storeId, shopifyOrderId: { in: toFetch }, bookingLockedAt: lockTs },
    select: { shopifyOrderId: true },
  });
  const lockedIds = new Set(lockedRecords.map((s) => s.shopifyOrderId));

  // Orders we couldn't lock → already in-flight elsewhere
  for (const orderId of toFetch) {
    if (!lockedIds.has(orderId)) {
      results.push({
        orderId,
        orderName: orderId,
        ok:      false,
        message: "Booking already in progress for this order.",
      });
    }
  }

  const toBatch = toFetch.filter((id) => lockedIds.has(id));
  if (!toBatch.length) {
    return { ok: false, message: "No bookable orders available.", results };
  }

  // ── 3. Fetch Shopify orders + resolve cities in parallel ─────────────────────
  const fetchedOrders = await Promise.all(
    toBatch.map((orderId) =>
      getOrder({ admin, storeId, orderId, defaultWeightGrams: settings.defaultWeightGrams, codKeywords }),
    ),
  );

  // Collect all destination city names, resolve in a single DB query
  const cityNames = fetchedOrders.map((o) => o?.destinationCity ?? "").filter(Boolean);
  const cityMap = await batchResolveCitiesInMemory(storeId, cityNames);

  const packetsToBook = [];
  const orderContext = [];

  for (let i = 0; i < toBatch.length; i++) {
    const orderId = toBatch[i];
    const order = fetchedOrders[i];

    if (!order) {
      await db.shipment
        .updateMany({ where: { storeId, shopifyOrderId: orderId }, data: { bookingLockedAt: null } })
        .catch(() => {});
      results.push({ orderId, orderName: orderId, ok: false, message: "Order not found in Shopify." });
      continue;
    }

    const destinationCity = cityMap.get(order.destinationCity) ?? null;
    const payload = buildPayload(order, settings, destinationCity);
    const validation = validateBookingPayload(payload);

    if (!validation.ok) {
      await db.shipment
        .updateMany({ where: { storeId, shopifyOrderId: orderId }, data: { bookingLockedAt: null } })
        .catch(() => {});
      results.push({
        orderId,
        orderName: order.name,
        ok:          false,
        message:     "Invalid order data: " + Object.keys(validation.errors).join(", "),
        fieldErrors: validation.errors,
      });
      continue;
    }

    packetsToBook.push(payload);
    orderContext.push({ order, destinationCity, orderId });
  }

  if (!packetsToBook.length) {
    return { ok: false, message: "No valid orders to book.", results };
  }

  // ── 4. Call Leopards batch API ───────────────────────────────────────────────
  const client = new LeopardApiClient({ storeId, settings });
  const apiResult = await client.batchBookPacket(packetsToBook);

  const dataArr = Array.isArray(apiResult.data)
    ? apiResult.data
    : Array.isArray(apiResult.raw?.data)
      ? apiResult.raw.data
      : [];

  // Total failure with no per-packet data
  if (!apiResult.ok && !dataArr.length) {
    for (const { order, orderId } of orderContext) {
      await db.shipment
        .updateMany({
          where: { storeId, shopifyOrderId: orderId },
          data: { lastError: apiResult.message?.slice(0, 1000), bookingLockedAt: null },
        })
        .catch(() => {});
      results.push({ orderId, orderName: order.name, ok: false, message: apiResult.message ?? "Batch booking failed." });
    }
    return { ok: false, message: apiResult.message ?? "Batch booking failed.", results };
  }

  // ── 5. Correlate results by booked_packet_order_id (NEVER by position) ───────
  const byOrderName = new Map();
  for (const item of dataArr) {
    const key = item?.booked_packet_order_id ? String(item.booked_packet_order_id) : null;
    if (key) byOrderName.set(key, item);
  }

  // ── 6. Persist each result + collect writeback tasks ─────────────────────────
  const writebackTasks = [];

  for (let i = 0; i < orderContext.length; i++) {
    const { order, destinationCity, orderId } = orderContext[i];
    // Prefer ID-based lookup; fall back to positional only when no IDs were returned
    const item = byOrderName.get(order.name) ?? (byOrderName.size === 0 ? dataArr[i] : undefined);
    const trackNumber = item?.track_number;
    const slipLink = item?.slip_link;

    if (!trackNumber) {
      const rawError =
        item?.error ??
        apiResult.raw?.error?.[`bookPacket - ${i}`] ??
        "Leopards rejected this packet.";
      const errMsg = typeof rawError === "string" ? rawError : JSON.stringify(rawError);
      await db.shipment
        .updateMany({
          where: { storeId, shopifyOrderId: orderId },
          data: { lastError: errMsg.slice(0, 1000), bookingLockedAt: null },
        })
        .catch(() => {});
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
            status:              "BOOKED",
            codAmount:           packetsToBook[i].booked_packet_collect_amount,
            weightGrams:         packetsToBook[i].booked_packet_weight,
            originCityId:        settings.originCityId,
            destinationCityId:   destinationCity?.leopardCityId ?? null,
            consigneeName:       order.customerName,
            consigneePhone:      order.customerPhone,
            consigneeAddress:    order.address,
            cancelledAt:         null,
            lastError:           null,
            bookingLockedAt:     null,
            bookedAt:            new Date(),
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

      if (trackNumber && settings.fulfillmentWritebackEnabled) {
        writebackTasks.push(() =>
          writebackFulfillment(admin, order.id, trackNumber, slipLink, order.note),
        );
      }

      results.push({ orderId, orderName: order.name, cnNumber: trackNumber, ok: true, message: `Booked with CN ${trackNumber}` });
    } catch (dbErr) {
      console.error(`[bookOrdersBatch] DB commit failed for ${order.name}:`, dbErr);
      await releaseLock(storeId, orderId);
      results.push({ orderId, orderName: order.name, ok: false, message: "Failed to save booking. The CN may have been created — check with Leopards." });
    }
  }

  // ── 7. Parallel Shopify writeback (non-fatal) ─────────────────────────────────
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
