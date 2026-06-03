// Single source of truth for COD detection and calculation.
// Used by webhook handlers AND the booking service so both paths always agree.

// Keywords that indicate a NON-cod payment method (online/card payments).
// Match against the joined payment_gateway_names string (lowercase).
const ONLINE_PAYMENT_KEYWORDS = [
  "visa", "mastercard", "stripe", "paypal", "bank", "credit", "debit",
  "online", "easypaisa", "jazzcash", "nayapay", "sadapay",
];

/**
 * Determines whether an order is a Cash-on-Delivery order.
 *
 * Priority:
 *  1. If gateway text contains a COD keyword → is COD (even if it also contains online keywords)
 *  2. If gateway text is empty/missing → default to COD (Pakistani stores almost always COD)
 *  3. If gateway text contains an online payment keyword → NOT COD
 *  4. Unknown gateway → default to COD
 *
 * @param {string[]} gatewayNames - order.payment_gateway_names or order.paymentGatewayNames
 * @param {string[]} codKeywords  - from store settings (e.g. ["cod", "cash on delivery"])
 */
export function isCodOrder(gatewayNames, codKeywords) {
  const text = (gatewayNames ?? []).join(" ").toLowerCase().trim();

  if (!text) return true; // No gateway info → default COD

  const hasCodKeyword = codKeywords.some((kw) => kw && text.includes(kw));
  if (hasCodKeyword) return true;

  const hasOnlineKeyword = ONLINE_PAYMENT_KEYWORDS.some((k) => text.includes(k));
  if (hasOnlineKeyword) return false;

  return true; // Unknown gateway → default COD
}

/**
 * Calculates the COD amount to store/send to Leopards.
 * Returns 0 for prepaid orders, rounded total for COD orders.
 *
 * @param {string[]} gatewayNames
 * @param {string|number} totalPrice - string like "1500.00" or number
 * @param {string[]} codKeywords
 */
export function calculateCodAmount(gatewayNames, totalPrice, codKeywords) {
  const raw = parseFloat(String(totalPrice ?? "0"));
  const amount = Number.isFinite(raw) ? raw : 0;
  return isCodOrder(gatewayNames, codKeywords) ? Math.round(amount) : 0;
}
