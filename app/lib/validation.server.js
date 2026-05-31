export function normalizeString(value) {
  return String(value ?? "").trim();
}

export function normalizePhone(value) {
  return normalizeString(value).replace(/[^\d+]/g, "");
}

export function normalizeCity(value) {
  return normalizeString(value).toLowerCase().replace(/\s+/g, " ");
}

export function parsePositiveInt(value, fallback = null) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallback;
}

export function parseNonNegativeInt(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return fallback;
}

export function validateBookingPayload(payload) {
  const errors = {};
  const required = [
    "booked_packet_weight",
    "booked_packet_no_piece",
    "booked_packet_collect_amount",
    "origin_city",
    "destination_city",
    "shipment_id",
    "shipment_name_eng",
    "shipment_phone",
    "shipment_address",
    "consignment_name_eng",
    "consignment_phone",
    "consignment_address",
    "special_instructions",
  ];

  for (const field of required) {
    if (
      payload[field] === undefined ||
      payload[field] === null ||
      payload[field] === ""
    ) {
      errors[field] = "Required";
    }
  }

  if (Number(payload.booked_packet_weight) <= 0) {
    errors.booked_packet_weight = "Weight must be greater than zero";
  }

  if (Number(payload.booked_packet_no_piece) <= 0) {
    errors.booked_packet_no_piece = "Pieces must be greater than zero";
  }

  if (Number(payload.booked_packet_collect_amount) < 0) {
    errors.booked_packet_collect_amount = "COD amount cannot be negative";
  }

  if (Number(payload.shipment_id) <= 0) {
    errors.shipment_id = "Shipment type must be a valid Leopards shipment ID";
  }

  if (normalizePhone(payload.consignment_phone).length < 10) {
    errors.consignment_phone = "A valid consignee phone is required";
  }

  return {
    ok: Object.keys(errors).length === 0,
    errors,
  };
}
