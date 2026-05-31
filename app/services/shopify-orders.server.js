import db from "../db.server";

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

const DEFAULT_COD_KEYWORDS = ["cod", "cash on delivery"];

function isCodOrder(order, codKeywords = DEFAULT_COD_KEYWORDS) {
  const gatewayText = (order.paymentGatewayNames ?? []).join(" ").toLowerCase();
  // If no gateway info at all, treat as COD (safer default for Pakistani stores).
  if (!gatewayText) return true;
  // If any keyword matches, it's COD.
  if (codKeywords.some((keyword) => keyword && gatewayText.includes(keyword))) return true;
  // If paid online (card/bank), it's NOT COD.
  const onlineKeywords = ["visa", "mastercard", "stripe", "paypal", "bank", "credit", "debit", "online"];
  if (onlineKeywords.some((k) => gatewayText.includes(k))) return false;
  // Default to COD for unknown gateways.
  return true;
}

export function shapeOrder(order, shipment = null, defaultWeightGrams = 1000, codKeywords = DEFAULT_COD_KEYWORDS) {
  const shipping = order.shippingAddress ?? {};
  const total = order.totalPriceSet?.shopMoney;
  // totalPriceSet.shopMoney.amount is a string like "1500.00" — parse and round.
  const rawAmount = parseFloat(total?.amount ?? "0");
  const codAmount = isCodOrder(order, codKeywords)
    ? Math.round(isNaN(rawAmount) ? 0 : rawAmount)
    : 0;

  const isCancelledShipment = shipment?.status === "CANCELLED";

  return {
    id: order.id,
    name: order.name,
    customerName: shipping.name ?? order.customer?.displayName ?? "Unknown customer",
    customerEmail: order.customer?.email ?? order.email ?? "",
    customerPhone: shipping.phone ?? order.customer?.phone ?? order.phone ?? "",
    destinationCity: shipping.city ?? "",
    address: [shipping.address1, shipping.address2, shipping.city, shipping.province, shipping.zip]
      .filter(Boolean)
      .join(", "),
    financialStatus: order.displayFinancialStatus,
    codAmount,
    currency: total?.currencyCode ?? "PKR",
    weightGrams: defaultWeightGrams,
    note: order.note ?? "",
    bookingStatus: isCancelledShipment ? "PENDING" : shipment?.status ?? "PENDING",
    cnNumber: isCancelledShipment ? "" : shipment?.cnNumber ?? "",
    slipLink: isCancelledShipment ? "" : shipment?.slipLink ?? "",
    lastError: shipment?.lastError ?? "",
  };
}

export async function listOrders({
  admin,
  storeId,
  query = "",
  first = 25,
  after = null,
  before = null,
  defaultWeightGrams = 1000,
  codKeywords = DEFAULT_COD_KEYWORDS,
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
    hasNextPage: false,
    hasPreviousPage: false,
    startCursor: null,
    endCursor: null,
  };
  const nodes = edges.map((edge) => edge.node);
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
      shapeOrder(order, byOrderId.get(order.id), defaultWeightGrams, codKeywords),
    ),
    pageInfo,
  };
}

export async function getOrder({
  admin,
  storeId,
  orderId,
  defaultWeightGrams = 1000,
  codKeywords = DEFAULT_COD_KEYWORDS,
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

  return shapeOrder(order, shipment, defaultWeightGrams, codKeywords);
}
