// Single source of truth for COD calculation.
//
// Rule: financialStatus === 'PAID' means the customer already paid online → collect nothing.
//       Any other status (PENDING, AUTHORIZED, PARTIALLY_PAID, etc.) → collect on delivery.
//
// This function is used by:
//   - Webhook handlers (orders/create, orders/paid) when seeding Shipment.codAmount
//   - Booking service (buildPayload) as the pre-fill value; merchant may override in the modal
//   - The stored Shipment.codAmount is LOCKED at booking and never re-calculated afterwards

/**
 * Calculates the COD amount to send to Leopards.
 *
 * @param {string} financialStatus - Shopify order financialStatus (e.g. 'PAID', 'PENDING')
 * @param {number} totalPrice      - Raw order total in smallest currency unit (paise / cents)
 * @returns {number} 0 if already paid; rounded total otherwise
 */
export function codFromFinancialStatus(financialStatus, totalPrice) {
  const amount = Number.isFinite(totalPrice) ? totalPrice : 0;
  return financialStatus === "PAID" ? 0 : Math.round(amount);
}
