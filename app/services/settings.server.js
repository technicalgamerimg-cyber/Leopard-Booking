import db from "../db.server";
import { decryptSecret, encryptSecret, maskSecret } from "../lib/crypto.server";
import { normalizeString, parsePositiveInt } from "../lib/validation.server";
import { LeopardApiClient } from "../integrations/leopards/client.server";

const DEFAULT_COD_KEYWORDS = "cod,cash on delivery";

function safeDecrypt(value) {
  if (!value) return null;
  try {
    return decryptSecret(value);
  } catch (err) {
    console.error("[settings] failed to decrypt secret:", err.message);
    return null;
  }
}

function shapeSettings(settings) {
  return {
    ...settings,
    leopardApiKeyMasked: maskSecret(settings.leopardApiKey),
    leopardApiPasswordMasked: maskSecret(settings.leopardApiPassword),
    hasCredentials: Boolean(
      settings.leopardApiKey && settings.leopardApiPassword,
    ),
    codGatewayKeywords: settings.codGatewayKeywords ?? DEFAULT_COD_KEYWORDS,
  };
}

export async function getSettings(storeId, { decrypt = false } = {}) {
  let settings = await db.settings.findUnique({ where: { storeId } });
  if (!settings) {
    settings = await db.settings.create({
      data: {
        storeId,
        defaultShipmentId: Number(process.env.LEOPARDS_DEFAULT_SHIPMENT_ID ?? 1),
        defaultWeightGrams: Number(process.env.DEFAULT_PACKET_WEIGHT_GRAMS ?? 1000),
        leopardEnvironment:
          process.env.LEOPARDS_DEFAULT_ENVIRONMENT === "production"
            ? "production"
            : "staging",
      },
    });
  }

  if (!decrypt) {
    return shapeSettings(settings);
  }

  return {
    ...settings,
    leopardApiKey: safeDecrypt(settings.leopardApiKey),
    leopardApiPassword: safeDecrypt(settings.leopardApiPassword),
    codGatewayKeywords: settings.codGatewayKeywords ?? DEFAULT_COD_KEYWORDS,
  };
}

export function getCodKeywords(settings) {
  const raw = settings?.codGatewayKeywords ?? DEFAULT_COD_KEYWORDS;
  return raw
    .split(",")
    .map((keyword) => keyword.trim().toLowerCase())
    .filter(Boolean);
}

export async function saveSettings(storeId, formData) {
  const current = await getSettings(storeId);
  const apiKey = normalizeString(formData.get("apiKey"));
  const apiPassword = normalizeString(formData.get("apiPassword"));
  const environment = formData.has("environment")
    ? formData.get("environment") === "production"
      ? "production"
      : "staging"
    : current.leopardEnvironment;

  const data = {
    leopardEnvironment: environment,
    originCityId: formData.has("originCityId")
      ? parsePositiveInt(formData.get("originCityId"))
      : current.originCityId,
    shipperName: formData.has("shipperName")
      ? normalizeString(formData.get("shipperName")) || null
      : current.shipperName,
    shipperPhone: formData.has("shipperPhone")
      ? normalizeString(formData.get("shipperPhone")) || null
      : current.shipperPhone,
    shipperEmail: formData.has("shipperEmail")
      ? normalizeString(formData.get("shipperEmail")) || null
      : current.shipperEmail,
    shipperAddress: formData.has("shipperAddress")
      ? normalizeString(formData.get("shipperAddress")) || null
      : current.shipperAddress,
    defaultShipmentId: formData.has("defaultShipmentId")
      ? parsePositiveInt(
          formData.get("defaultShipmentId"),
          current.defaultShipmentId ?? 1,
        )
      : current.defaultShipmentId,
    defaultWeightGrams: formData.has("defaultWeightGrams")
      ? parsePositiveInt(
          formData.get("defaultWeightGrams"),
          current.defaultWeightGrams,
        )
      : current.defaultWeightGrams,
    defaultSpecialInstructions: formData.has("defaultSpecialInstructions")
      ? normalizeString(formData.get("defaultSpecialInstructions")) || null
      : current.defaultSpecialInstructions,
    fulfillmentWritebackEnabled: true,
    codGatewayKeywords: formData.has("codGatewayKeywords")
      ? normalizeString(formData.get("codGatewayKeywords")) || null
      : current.codGatewayKeywords,
  };

  if (apiKey) data.leopardApiKey = encryptSecret(apiKey);
  if (apiPassword) data.leopardApiPassword = encryptSecret(apiPassword);

  const savedAny = formData.has("section") ? formData.get("section") : "all";

  await db.settings.update({ where: { storeId }, data });

  return {
    ok: true,
    section: savedAny,
    message:
      current.hasCredentials || apiKey || apiPassword
        ? "Settings saved."
        : "Settings saved. Add Leopards credentials before booking shipments.",
  };
}

export async function clearCredentials(storeId) {
  await db.settings.update({
    where: { storeId },
    data: { leopardApiKey: null, leopardApiPassword: null },
  });

  return { ok: true, message: "Leopards credentials cleared." };
}

export async function testConnection(storeId) {
  const settings = await getSettings(storeId, { decrypt: true });

  if (!settings.leopardApiKey || !settings.leopardApiPassword) {
    return { ok: false, message: "Enter and save Leopards credentials first." };
  }

  const client = new LeopardApiClient({ storeId, settings });
  const result = await client.getAllCities();

  if (!result.ok) return result;
  return { ok: true, message: "Leopards API connection successful." };
}
