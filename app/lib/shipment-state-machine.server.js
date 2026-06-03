// Central shipment state machine.
// Every status mutation in the system MUST go through canTransition() or applyTransition().
// No file may set shipment.status directly without validating here first.

const TRANSITIONS = {
  PENDING:    ["BOOKED", "CANCELLED"],
  BOOKED:     ["IN_TRANSIT", "CANCELLED", "EXCEPTION"],
  IN_TRANSIT: ["DELIVERED", "RETURNED", "CANCELLED", "EXCEPTION"],
  EXCEPTION:  ["IN_TRANSIT", "CANCELLED"],
  // Terminal — no outgoing edges
  DELIVERED:  [],
  RETURNED:   [],
  CANCELLED:  [],
};

export const TERMINAL_STATUSES = Object.freeze(["DELIVERED", "CANCELLED", "RETURNED"]);

export const ALL_STATUSES = Object.freeze(Object.keys(TRANSITIONS));

/**
 * Returns true if the transition from → to is valid.
 * Always returns false if `from` is a terminal status.
 */
export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Returns true if `status` is a terminal state (immutable).
 */
export function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Given a desired next status and the current status, returns:
 *  - the next status if the transition is valid
 *  - the current status unchanged if the transition is invalid (prevents regression)
 *
 * Logs a warning on invalid attempts so they are visible in production logs.
 */
export function safeTransition(currentStatus, desiredStatus, context = "") {
  if (currentStatus === desiredStatus) return currentStatus;

  if (isTerminal(currentStatus)) {
    console.warn(
      `[state-machine] Blocked: cannot transition terminal status ${currentStatus} → ${desiredStatus}` +
        (context ? ` (${context})` : ""),
    );
    return currentStatus;
  }

  if (!canTransition(currentStatus, desiredStatus)) {
    console.warn(
      `[state-machine] Blocked: invalid transition ${currentStatus} → ${desiredStatus}` +
        (context ? ` (${context})` : ""),
    );
    return currentStatus;
  }

  return desiredStatus;
}

/**
 * Returns the set of statuses that a shipment can be cancelled from.
 * Used to filter DB queries before calling Leopards cancel API.
 */
export function cancellableStatuses() {
  return ALL_STATUSES.filter((s) => canTransition(s, "CANCELLED"));
}
