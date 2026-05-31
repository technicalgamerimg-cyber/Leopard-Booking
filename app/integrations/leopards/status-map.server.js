const STATUS_MAP = [
  { match: ["delivered"], status: "DELIVERED" },
  { match: ["cancel"], status: "CANCELLED" },
  { match: ["return"], status: "RETURNED" },
  { match: ["dispatch", "transit", "arrived", "out for delivery", "assigned"], status: "IN_TRANSIT" },
  { match: ["booked", "pickup", "pending"], status: "BOOKED" },
  { match: ["hold", "failed"], status: "EXCEPTION" },
];

export function mapLeopardStatus(rawStatus) {
  const normalized = String(rawStatus ?? "").toLowerCase();

  for (const entry of STATUS_MAP) {
    if (entry.match.some((item) => normalized.includes(item))) {
      return entry.status;
    }
  }

  return normalized ? "EXCEPTION" : "PENDING";
}
