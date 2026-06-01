import db from "../db.server";
import { LeopardApiClient } from "../integrations/leopards/client.server";
import {
  normalizePhone,
  parseNonNegativeInt,
  parsePositiveInt,
  validateBookingPayload,
} from "../lib/validation.server";
import { resolveCity } from "./city.server";
import { getSettings, getCodKeywords } from "./settings.server";
import { getOrder } from "./shopify-orders.server";

const FULFILLMENT_ORDERS_QUERY = `#graphql
  query FulfillmentOrdersForOrder($orderId: ID!) {
    order(id: $orderId) {
      fulfillmentOrders(first: 5) {
        nodes {
          id
          status
          supportedActions {
            action
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
        trackingInfo {
          number
          url
          company
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const ORDER_UPDATE_MUTATION = `#graphql
  mutation OrderUpdate($input: OrderInput!) {
    orderUpdate(input: $input) {
      order {
        id
        note
      }
      userErrors {
        field
        message
      }
    }
  }
`;

async function writeOrderNote(admin, orderId, cnNumber, existingNote = "") {
  try {
    const cnLine = `Leopards CN: ${cnNumber}`;
    let updatedNote;
    if (existingNote && /Leopards CN:/i.test(existingNote)) {
      updatedNote = existingNote.replace(/Leopards CN:.*$/im, cnLine);
    } else {
      updatedNote = existingNote ? `${existingNote.trim()}\n${cnLine}` : cnLine;
    }

    const response = await admin.graphql(ORDER_UPDATE_MUTATION, {
      variables: { input: { id: orderId, note: updatedNote } },
    });
    const json = await response.json();
    const errors = json.data?.orderUpdate?.userErrors ?? [];
    if (errors.length) {
      console.error("[order note] orderUpdate errors:", JSON.stringify(errors));
    } else {
      console.log(`[order note] ✅ CN ${cnNumber} written to order note for ${orderId}`);
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

    console.log(
      "[fulfillment writeback] fulfillmentOrders raw:",
      JSON.stringify(foJson.data?.order?.fulfillmentOrders?.nodes ?? []),
    );

    const fulfillmentOrders =
      foJson.data?.order?.fulfillmentOrders?.nodes ?? [];

    // Prefer an FO where our token explicitly has CREATE_FULFILLMENT action;
    // fall back to any OPEN FO for tokens that predate the
    // write_merchant_managed_fulfillment_orders scope grant.
    const openFo =
      fulfillmentOrders.find((fo) =>
        fo.supportedActions?.some((a) => a.action === "CREATE_FULFILLMENT"),
      ) ?? fulfillmentOrders.find((fo) => fo.status === "OPEN");

    if (!openFo) {
      console.warn(
        `[fulfillment writeback] No fulfillable order for ${orderId}. Statuses: ${
          fulfillmentOrders.map((f) => `${f.status}[${f.supportedActions?.map((a) => a.action).join(",")}]`).join(", ") || "none"
        }`,
      );
      return;
    }

    console.log(`[fulfillment writeback] Using fulfillment order ${openFo.id} status=${openFo.status}`);

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
    console.log(
      "[fulfillment writeback] fulfillmentCreate response:",
      JSON.stringify(createJson.data?.fulfillmentCreate),
    );

    const errors = createJson.data?.fulfillmentCreate?.userErrors ?? [];
    if (errors.length) {
      console.error("[fulfillment writeback] fulfillmentCreate errors:", JSON.stringify(errors));
      return;
    }

    const fulfillmentId = createJson.data?.fulfillmentCreate?.fulfillment?.id;
    console.log(
      `[fulfillment writeback] ✅ CN ${cnNumber} fulfilled on order ${orderId} — fulfillment ${fulfillmentId}`,
    );

    await writeOrderNote(admin, orderId, cnNumber, existingNote);
  } catch (err) {
    console.error("[fulfillment writeback] Unexpected error:", err);
  }
}

function buildPayload(order, settings, destinationCity, overrides = {}) {
  const weight = overrides.weightGrams ?? order.weightGrams;
  const pieces = overrides.noOfPieces ?? 1;
  const codAmount = overrides.codAmount ?? order.codAmount;
  const specialInstructions =
    overrides.specialInstructions ||
    order.note ||
    settings.defaultSpecialInstructions ||
    "Handle with care";

  return {
    booked_packet_weight: weight,
    booked_packet_no_piece: pieces,
    booked_packet_collect_amount: codAmount,
    origin_city: settings.originCityId || "self",
    destination_city: destinationCity?.leopardCityId,
    shipment_id: settings.defaultShipmentId || 1,
    shipment_name_eng: settings.shipperName || "self",
    shipment_email: settings.shipperEmail || "self",
    shipment_phone: settings.shipperPhone || "self",
    shipment_address: settings.shipperAddress || "self",
    consignment_name_eng: order.customerName,
    consignment_email: order.customerEmail,
    consignment_phone: normalizePhone(order.customerPhone),
    consignment_address: order.address,
    special_instructions: specialInstructions,
    booked_packet_order_id: order.name,
  };
}

function extractBookingData(result) {
  const data = Array.isArray(result.data) ? result.data[0] : result.data;
  return {
    trackNumber: data?.track_number ?? result.raw?.track_number,
    slipLink: data?.slip_link ?? result.raw?.slip_link,
    bookedPacketOrderId:
      data?.booked_packet_order_id ?? result.raw?.booked_packet_order_id,
  };
}

function parseOverrides(rawOverrides = {}) {
  if (!rawOverrides) return {};
  const weight = parsePositiveInt(rawOverrides.weightGrams);
  const pieces = parsePositiveInt(rawOverrides.noOfPieces);
  const cod = parseNonNegativeInt(rawOverrides.codAmount, null);

  return {
    weightGrams: weight ?? undefined,
    noOfPieces: pieces ?? undefined,
    codAmount: cod ?? undefined,
    specialInstructions:
      typeof rawOverrides.specialInstructions === "string"
        ? rawOverrides.specialInstructions.trim() || undefined
        : undefined,
  };
}

export async function bookOrder({
  admin,
  storeId,
  orderId,
  overrides: rawOverrides = {},
}) {
  const settings = await getSettings(storeId, { decrypt: true });
  const codKeywords = getCodKeywords(settings);
  const overrides = parseOverrides(rawOverrides);

  const existing = await db.shipment.findUnique({
    where: {
      storeId_shopifyOrderId: { storeId, shopifyOrderId: orderId },
    },
  });

  if (existing && existing.status !== "CANCELLED") {
    return { ok: false, message: "This order already has an active shipment." };
  }

  const order = await getOrder({
    admin,
    storeId,
    orderId,
    defaultWeightGrams: settings.defaultWeightGrams,
    codKeywords,
  });

  if (!order) return { ok: false, message: "Shopify order was not found." };
  if (!settings.leopardApiKey || !settings.leopardApiPassword) {
    return { ok: false, message: "Save Leopards credentials before booking." };
  }

  const destinationCity = await resolveCity(storeId, order.destinationCity);
  const payload = buildPayload(order, settings, destinationCity, overrides);
  const validation = validateBookingPayload(payload);

  if (!validation.ok) {
    return {
      ok: false,
      message: "Fix the order data before booking.",
      fieldErrors: validation.errors,
    };
  }

  const client = new LeopardApiClient({ storeId, settings });
  console.log(`[bookOrder] Booking ${order.name} | COD: ${payload.booked_packet_collect_amount} | City: ${payload.destination_city} | Weight: ${payload.booked_packet_weight}`);
  const result = await client.bookPacket(payload);

  if (!result.ok) {
    await db.shipment.upsert({
      where: {
        storeId_shopifyOrderId: { storeId, shopifyOrderId: order.id },
      },
      create: {
        storeId,
        shopifyOrderId: order.id,
        shopifyOrderName: order.name,
        status: "PENDING",
        codAmount: payload.booked_packet_collect_amount,
        weightGrams: payload.booked_packet_weight,
        noOfPieces: payload.booked_packet_no_piece,
        destinationCityId: destinationCity?.leopardCityId,
        consigneeName: order.customerName,
        consigneePhone: order.customerPhone,
        consigneeAddress: order.address,
        lastError: result.message,
      },
      update: { lastError: result.message },
    });
    return result;
  }

  const booked = extractBookingData(result);
  const shipment = await db.shipment.upsert({
    where: {
      storeId_shopifyOrderId: { storeId, shopifyOrderId: order.id },
    },
    create: {
      storeId,
      shopifyOrderId: order.id,
      shopifyOrderName: order.name,
      cnNumber: booked.trackNumber,
      slipLink: booked.slipLink,
      bookedPacketOrderId: booked.bookedPacketOrderId || order.name,
      status: "BOOKED",
      codAmount: payload.booked_packet_collect_amount,
      weightGrams: payload.booked_packet_weight,
      noOfPieces: payload.booked_packet_no_piece,
      originCityId: settings.originCityId,
      destinationCityId: destinationCity?.leopardCityId,
      consigneeName: order.customerName,
      consigneePhone: order.customerPhone,
      consigneeAddress: order.address,
      bookedAt: new Date(),
    },
    update: {
      cnNumber: booked.trackNumber,
      slipLink: booked.slipLink,
      bookedPacketOrderId: booked.bookedPacketOrderId || order.name,
      status: "BOOKED",
      codAmount: payload.booked_packet_collect_amount,
      weightGrams: payload.booked_packet_weight,
      noOfPieces: payload.booked_packet_no_piece,
      originCityId: settings.originCityId,
      destinationCityId: destinationCity?.leopardCityId,
      cancelledAt: null,
      lastError: null,
      bookedAt: new Date(),
    },
  });

  await db.shipmentLog.create({
    data: {
      shipmentId: shipment.id,
      eventType: "BOOKED",
      toStatus: "BOOKED",
      message: `Booked with CN ${booked.trackNumber}`,
    },
  });

  if (booked.trackNumber && settings.fulfillmentWritebackEnabled) {
    await writebackFulfillment(
      admin,
      order.id,
      booked.trackNumber,
      booked.slipLink,
      order.note,
    );
  }

  return {
    ok: true,
    message: `${order.name} booked with CN ${booked.trackNumber}`,
    cnNumber: booked.trackNumber,
    slipLink: booked.slipLink,
  };
}

export async function bookOrdersBatch({ admin, storeId, orderIds }) {
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return { ok: false, message: "Select at least one order to book." };
  }

  const settings = await getSettings(storeId, { decrypt: true });
  if (!settings.leopardApiKey || !settings.leopardApiPassword) {
    return { ok: false, message: "Save Leopards credentials before booking." };
  }
  const codKeywords = getCodKeywords(settings);

  const results = [];
  const packetsToBook = [];
  const orderContext = [];

  // Single batch DB query instead of N sequential findUnique calls.
  const existingShipments = await db.shipment.findMany({
    where: {
      storeId,
      shopifyOrderId: { in: orderIds },
      status: { not: "CANCELLED" },
    },
    select: { shopifyOrderId: true, shopifyOrderName: true },
  });
  const bookedByOrderId = new Map(existingShipments.map((s) => [s.shopifyOrderId, s]));

  const toFetch = orderIds.filter((id) => !bookedByOrderId.has(id));
  for (const orderId of orderIds.filter((id) => bookedByOrderId.has(id))) {
    const existing = bookedByOrderId.get(orderId);
    results.push({ orderId, orderName: existing.shopifyOrderName, ok: false, message: "Already booked." });
  }

  if (!toFetch.length) {
    return { ok: false, message: "No bookable orders selected.", results };
  }

  // Fetch all Shopify orders in parallel.
  const fetchedOrders = await Promise.all(
    toFetch.map((orderId) =>
      getOrder({ admin, storeId, orderId, defaultWeightGrams: settings.defaultWeightGrams, codKeywords }),
    ),
  );

  // Resolve all destination cities in parallel.
  const resolvedCities = await Promise.all(
    fetchedOrders.map((order) =>
      order ? resolveCity(storeId, order.destinationCity) : Promise.resolve(null),
    ),
  );

  for (let i = 0; i < toFetch.length; i++) {
    const orderId = toFetch[i];
    const order = fetchedOrders[i];
    const destinationCity = resolvedCities[i];

    if (!order) {
      results.push({ orderId, orderName: orderId, ok: false, message: "Order not found in Shopify." });
      continue;
    }

    const payload = buildPayload(order, settings, destinationCity);
    const validation = validateBookingPayload(payload);

    if (!validation.ok) {
      results.push({
        orderId,
        orderName: order.name,
        ok: false,
        message: "Invalid order data: " + Object.keys(validation.errors).join(", "),
        fieldErrors: validation.errors,
      });
      continue;
    }

    packetsToBook.push(payload);
    orderContext.push({ order, destinationCity });
  }

  if (!packetsToBook.length) {
    return {
      ok: false,
      message: "No bookable orders selected.",
      results,
    };
  }

  const client = new LeopardApiClient({ storeId, settings });
  const result = await client.batchBookPacket(packetsToBook);

  if (
    !result.ok &&
    !Array.isArray(result.data) &&
    !Array.isArray(result.raw?.data)
  ) {
    // Total failure — surface the top-level error for each attempted order.
    for (const { order } of orderContext) {
      results.push({
        orderId: order.id,
        orderName: order.name,
        ok: false,
        message: result.message ?? "Batch booking failed.",
      });
    }
    return {
      ok: false,
      message: result.message ?? "Batch booking failed.",
      results,
    };
  }

  const dataArr = Array.isArray(result.data)
    ? result.data
    : Array.isArray(result.raw?.data)
      ? result.raw.data
      : [];

  // Correlate by position; also use booked_packet_order_id as a check.
  for (let i = 0; i < orderContext.length; i += 1) {
    const { order, destinationCity } = orderContext[i];
    const item = dataArr[i];
    const trackNumber = item?.track_number;
    const slipLink = item?.slip_link;
    const bookedPacketOrderId = item?.booked_packet_order_id;
    const payload = packetsToBook[i];

    if (!trackNumber) {
      // Per-packet error
      const itemError =
        item?.error ??
        result.raw?.error?.[`bookPacket - ${i}`] ??
        "Leopards rejected this packet.";
      await db.shipment.upsert({
        where: {
          storeId_shopifyOrderId: { storeId, shopifyOrderId: order.id },
        },
        create: {
          storeId,
          shopifyOrderId: order.id,
          shopifyOrderName: order.name,
          status: "PENDING",
          codAmount: payload.booked_packet_collect_amount,
          weightGrams: payload.booked_packet_weight,
          destinationCityId: destinationCity?.leopardCityId,
          consigneeName: order.customerName,
          consigneePhone: order.customerPhone,
          consigneeAddress: order.address,
          lastError:
            typeof itemError === "string"
              ? itemError
              : JSON.stringify(itemError),
        },
        update: {
          lastError:
            typeof itemError === "string"
              ? itemError
              : JSON.stringify(itemError),
        },
      });
      results.push({
        orderId: order.id,
        orderName: order.name,
        ok: false,
        message: typeof itemError === "string" ? itemError : "Booking failed.",
      });
      continue;
    }

    const shipment = await db.shipment.upsert({
      where: {
        storeId_shopifyOrderId: { storeId, shopifyOrderId: order.id },
      },
      create: {
        storeId,
        shopifyOrderId: order.id,
        shopifyOrderName: order.name,
        cnNumber: trackNumber,
        slipLink,
        bookedPacketOrderId: bookedPacketOrderId || order.name,
        status: "BOOKED",
        codAmount: payload.booked_packet_collect_amount,
        weightGrams: payload.booked_packet_weight,
        originCityId: settings.originCityId,
        destinationCityId: destinationCity?.leopardCityId,
        consigneeName: order.customerName,
        consigneePhone: order.customerPhone,
        consigneeAddress: order.address,
        bookedAt: new Date(),
      },
      update: {
        cnNumber: trackNumber,
        slipLink,
        bookedPacketOrderId: bookedPacketOrderId || order.name,
        status: "BOOKED",
        codAmount: payload.booked_packet_collect_amount,
        weightGrams: payload.booked_packet_weight,
        originCityId: settings.originCityId,
        destinationCityId: destinationCity?.leopardCityId,
        cancelledAt: null,
        lastError: null,
        bookedAt: new Date(),
      },
    });

    await db.shipmentLog.create({
      data: {
        shipmentId: shipment.id,
        eventType: "BOOKED",
        toStatus: "BOOKED",
        message: `Booked with CN ${trackNumber}`,
      },
    });

    // Write tracking back to Shopify if writeback is enabled.
    if (trackNumber && settings.fulfillmentWritebackEnabled) {
      await writebackFulfillment(admin, order.id, trackNumber, slipLink, order.note);
    }

    results.push({
      orderId: order.id,
      orderName: order.name,
      cnNumber: trackNumber,
      ok: true,
      message: `Booked with CN ${trackNumber}`,
    });
  }

  const successes = results.filter((r) => r.ok).length;
  const failures = results.length - successes;

  return {
    ok: successes > 0,
    message:
      failures === 0
        ? `${successes} order(s) booked.`
        : `${successes} booked, ${failures} failed.`,
    results,
  };
}
