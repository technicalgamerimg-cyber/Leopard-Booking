import db from "../db.server";
import { codFromFinancialStatus } from "../lib/cod.server";

// ── GraphQL fragments ─────────────────────────────────────────────────────────

const ORDER_FIELDS = `#graphql
  id
  name
  displayFinancialStatus
  paymentGatewayNames
  note
  phone
  email
  totalPriceSet {
    shopMoney { amount currencyCode }
  }
  currentTotalPriceSet {
    shopMoney { amount currencyCode }
  }
  customer {
    displayName
    email
    phone
  }
  shippingAddress {
    name
    phone
    address1
    address2
    city
    province
    zip
    country
  }
`;

const ORDERS_QUERY = `#graphql
  query LeopardOrders($first: Int, $last: Int, $query: String, $after: String, $before: String) {
    orders(first: $first, last: $last, sortKey: CREATED_AT, reverse: true, query: $query, after: $after, before: $before) {
      edges {
        cursor
        node {
          ${ORDER_FIELDS}
        }
      }
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
    }
  }
`;

const ORDER_BY_ID_QUERY = `#graphql
  query LeopardOrderById($id: ID!) {
    order(id: $id) {
      ${ORDER_FIELDS}
    }
  }
`;

// ── Order shaping ─────────────────────────────────────────────────────────────

export function shapeOrder(order, shipment = null, defaultWeightGrams = 1000) {
  const shipping = order.shippingAddress ?? {};

  const currentTotal   = order.currentTotalPriceSet?.shopMoney;
  const originalTotal  = order.totalPriceSet?.shopMoney;
  const effectiveTotal = currentTotal ?? originalTotal;
  const rawAmount      = parseFloat(effectiveTotal?.amount ?? "0");
  const safeAmount     = Math.round(Number.isFinite(rawAmount) ? rawAmount : 0);

  // COD rule: PAID → 0, everything else → order total
  const financialStatus = order.displayFinancialStatus ?? "PENDING";
  const codAmount       = codFromFinancialStatus(financialStatus, safeAmount);

  const isCancelledShipment = shipment?.status === "CANCELLED";

  return {
    id:              order.id,
    name:            order.name,
    customerName:    shipping.name ?? order.customer?.displayName ?? "Unknown customer",
    customerEmail:   order.customer?.email ?? order.email ?? "",
    customerPhone:   shipping.phone ?? order.customer?.phone ?? order.phone ?? "",
    destinationCity: shipping.city ?? "",
    address: [shipping.address1, shipping.address2, shipping.city, shipping.province, shipping.zip]
      .filter(Boolean)
      .join(", "),
    financialStatus,
    codAmount,
    currency:         effectiveTotal?.currencyCode ?? "PKR",
    weightGrams:      defaultWeightGrams,
    note:             order.note ?? "",
    bookingStatus:    isCancelledShipment ? "PENDING" : shipment?.status ?? "PENDING",
    cnNumber:         isCancelledShipment ? "" : shipment?.cnNumber ?? "",
    slipLink:         isCancelledShipment ? "" : shipment?.slipLink ?? "",
    lastError:        shipment?.lastError ?? "",
    shopifySyncStatus: !isCancelledShipment ? (shipment?.shopifySyncStatus ?? "SYNC_OK") : "SYNC_OK",
  };
}

// ── List orders (paginated) ───────────────────────────────────────────────────

export async function listOrders({
  admin,
  storeId,
  query = "",
  first = 25,
  after = null,
  before = null,
  defaultWeightGrams = 1000,
}) {
  // Shopify cursor pagination: use `last + before` for backward, `first + after` for forward.
  const variables = { query: query || null };
  if (before) {
    variables.last = first;
    variables.before = before;
  } else {
    variables.first = first;
    variables.after = after || null;
  }

  const response = await admin.graphql(ORDERS_QUERY, { variables });
  const json = await response.json();

  if (json.errors) {
    console.error("[listOrders] GraphQL errors:", JSON.stringify(json.errors));
  }

  const edges = json.data?.orders?.edges ?? [];
  const pageInfo = json.data?.orders?.pageInfo ?? {
    hasNextPage:     false,
    hasPreviousPage: false,
    startCursor:     null,
    endCursor:       null,
  };
  const nodes    = edges.map((edge) => edge.node);
  const orderIds = nodes.map((order) => order.id);
  const shipments = orderIds.length
    ? await db.shipment.findMany({
        where: {
          storeId,
          shopifyOrderId: { in: orderIds },
        },
      })
    : [];
  const byOrderId = new Map(shipments.map((shipment) => [shipment.shopifyOrderId, shipment]));

  return {
    orders: nodes.map((order) =>
      shapeOrder(order, byOrderId.get(order.id), defaultWeightGrams),
    ),
    pageInfo,
  };
}

// ── Get single order ──────────────────────────────────────────────────────────

export async function getOrder({
  admin,
  storeId,
  orderId,
  defaultWeightGrams = 1000,
}) {
  const response = await admin.graphql(ORDER_BY_ID_QUERY, {
    variables: { id: orderId },
  });
  const json = await response.json();

  if (json.errors) {
    console.error("[getOrder] GraphQL errors:", JSON.stringify(json.errors));
  }

  const order = json.data?.order;
  if (!order) return null;

  const shipment = await db.shipment.findUnique({
    where: { storeId_shopifyOrderId: { storeId, shopifyOrderId: order.id } },
  });

  return shapeOrder(order, shipment, defaultWeightGrams);
}
