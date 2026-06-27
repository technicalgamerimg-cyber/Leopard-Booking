import db from "../db.server";
import { decryptSecret, encryptSecret, maskSecret } from "../lib/crypto.server";
import { normalizeString, parsePositiveInt } from "../lib/validation.server";
import { LeopardApiClient } from "../integrations/leopards/client.server";

const DEFAULT_COD_KEYWORDS = "cod,cash on delivery";

// ── In-process settings cache (30s TTL) ──────────────────────────────────────
// Eliminates repeated DB round-trips for high-frequency webhook handlers and batch routes.
// Cache stores the RAW (encrypted) settings — decryption still happens per-request when needed.

const _cache = new Map(); // storeId → { raw: Settings, cachedAt: number }
const CACHE_TTL_MS = 30_000;

function _cachePut(storeId, raw) {
  _cache.set(storeId, { raw, cachedAt: Date.now() });
}

function _cacheGet(storeId) {
  const entry = _cache.get(storeId);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) { _cache.delete(storeId); return null; }
  return entry.raw;
}

export function invalidateSettingsCache(storeId) {
  _cache.delete(storeId);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

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
    leopardApiKeyMasked:      maskSecret(settings.leopardApiKey),
    leopardApiPasswordMasked: maskSecret(settings.leopardApiPassword),
    hasCredentials:           Boolean(settings.leopardApiKey && settings.leopardApiPassword),
    codGatewayKeywords:       settings.codGatewayKeywords ?? DEFAULT_COD_KEYWORDS,
  };
}

// ── Shared onboarding completion check ───────────────────────────────────────
// Single source of truth used by both app._index.jsx and app.onboarding.jsx.
// Changing the required fields here propagates to both routes automatically.

export function isOnboardingComplete(settings, cityStats) {
  return Boolean(
    settings.hasCredentials &&
    cityStats.count > 0 &&
    settings.originCityId &&
    settings.shipperName &&
    settings.shipperPhone &&
    settings.shipperAddress &&
    settings.defaultWeightGrams,
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getSettings(storeId, { decrypt = false } = {}) {
  let raw = _cacheGet(storeId);

  if (!raw) {
    try {
      raw = await db.settings.findUnique({ where: { storeId } });

      if (!raw) {
        raw = await db.settings.upsert({
          where:  { storeId },
          create: {
            storeId,
            defaultShipmentId:  Number(process.env.LEOPARDS_DEFAULT_SHIPMENT_ID ?? 1),
            defaultWeightGrams: Number(process.env.DEFAULT_PACKET_WEIGHT_GRAMS ?? 1000),
            // Leopards staging is no longer supported. Always use production API.
            leopardEnvironment: "production",
          },
          update: {},
        });
      } else if (raw.leopardEnvironment === "staging") {
        // One-time self-healing migration: existing rows stored "staging" before
        // the staging option was removed. Repair on first access so bookings
        // hit the correct production API without requiring a manual settings save.
        raw = await db.settings.update({
          where: { storeId },
          data:  { leopardEnvironment: "production" },
        });
      }

      _cachePut(storeId, raw);
    } catch (err) {
      console.error("[settings] getSettings DB error for store", storeId, ":", err.message);
      throw err;
    }
  }

  if (!decrypt) return shapeSettings(raw);

  return {
    ...raw,
    leopardApiKey:      safeDecrypt(raw.leopardApiKey),
    leopardApiPassword: safeDecrypt(raw.leopardApiPassword),
    codGatewayKeywords: raw.codGatewayKeywords ?? DEFAULT_COD_KEYWORDS,
  };
}

export function getCodKeywords(settings) {
  const raw = settings?.codGatewayKeywords ?? DEFAULT_COD_KEYWORDS;
  return raw.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
}

export async function saveSettings(storeId, formData) {
  const current = await getSettings(storeId);
  const apiKey      = normalizeString(formData.get("apiKey"));
  const apiPassword = normalizeString(formData.get("apiPassword"));

  // Leopards staging is no longer supported. Always use production API.
  const environment = "production";

  const data = {
    leopardEnvironment: environment,
    // Provide current.originCityId as fallback so an invalid dropdown value
    // (empty string, "0", NaN) never silently clears the origin city.
    originCityId: formData.has("originCityId")
      ? parsePositiveInt(formData.get("originCityId"), current.originCityId)
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
      ? parsePositiveInt(formData.get("defaultShipmentId"), current.defaultShipmentId ?? 1)
      : current.defaultShipmentId,
    defaultWeightGrams: formData.has("defaultWeightGrams")
      ? parsePositiveInt(formData.get("defaultWeightGrams"), current.defaultWeightGrams)
      : current.defaultWeightGrams,
    defaultSpecialInstructions: formData.has("defaultSpecialInstructions")
      ? normalizeString(formData.get("defaultSpecialInstructions")) || null
      : current.defaultSpecialInstructions,
    fulfillmentWritebackEnabled: formData.has("fulfillmentWritebackEnabled")
      ? formData.get("fulfillmentWritebackEnabled") === "on"
      : current.fulfillmentWritebackEnabled,
    codGatewayKeywords: formData.has("codGatewayKeywords")
      ? normalizeString(formData.get("codGatewayKeywords")) || null
      : current.codGatewayKeywords,
  };

  if (apiKey)      data.leopardApiKey      = encryptSecret(apiKey);
  if (apiPassword) data.leopardApiPassword = encryptSecret(apiPassword);

  // Use try/finally so the cache is always invalidated, even if the DB write
  // fails. Without this, a failed update leaves stale cached data for up to 30s.
  try {
    await db.settings.update({ where: { storeId }, data });
  } finally {
    invalidateSettingsCache(storeId);
  }

  return {
    ok: true,
    message: current.hasCredentials || apiKey || apiPassword
      ? "Settings saved."
      : "Settings saved. Add Leopards credentials before booking shipments.",
  };
}

export async function clearCredentials(storeId) {
  try {
    await db.settings.update({
      where: { storeId },
      data:  { leopardApiKey: null, leopardApiPassword: null },
    });
  } finally {
    invalidateSettingsCache(storeId);
  }
  return { ok: true, message: "Leopards credentials cleared." };
}

export async function testConnection(storeId) {
  const settings = await getSettings(storeId, { decrypt: true });
  if (!settings.leopardApiKey || !settings.leopardApiPassword) {
    return { ok: false, message: "Enter and save Leopards credentials first." };
  }
  const client = new LeopardApiClient({ storeId, settings });
  try {
    const result = await client.getAllCities();
    if (!result.ok) return { ok: false, message: result.message };
    return { ok: true, message: "Leopards API connection successful." };
  } catch (err) {
    console.error("[settings] testConnection unexpected error:", err.message);
    return { ok: false, message: `Connection test failed: ${err.message}` };
  }
}
