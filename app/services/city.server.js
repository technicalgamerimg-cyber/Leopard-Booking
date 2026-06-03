import db from "../db.server";
import { normalizeCity } from "../lib/validation.server";
import { getSettings } from "./settings.server";
import { LeopardApiClient } from "../integrations/leopards/client.server";

function extractCities(result) {
  const source = result?.data?.city_list ?? result?.raw?.city_list ?? result?.data ?? [];
  return Array.isArray(source) ? source : [];
}

// ── Cache refresh ─────────────────────────────────────────────────────────────

export async function refreshCities(storeId) {
  const settings = await getSettings(storeId, { decrypt: true });
  const client   = new LeopardApiClient({ storeId, settings });
  const result   = await client.getAllCities();

  if (!result.ok) return result;

  const cities = extractCities(result);
  const validCities = cities.filter((city) => {
    const id   = Number(city.id ?? city.city_id ?? city.leopard_city_id);
    const name = city.name ?? city.city_name ?? city.cityName;
    return id && name;
  });

  if (!validCities.length) {
    return { ok: false, message: "No valid cities returned by Leopards API." };
  }

  // Delete-then-create inside a transaction: fastest pattern for periodic full refresh.
  await db.$transaction([
    db.cityCache.deleteMany({ where: { storeId } }),
    db.cityCache.createMany({
      data: validCities.map((city) => ({
        storeId,
        leopardCityId:  Number(city.id ?? city.city_id ?? city.leopard_city_id),
        name:           city.name ?? city.city_name ?? city.cityName,
        nameNormalized: normalizeCity(city.name ?? city.city_name ?? city.cityName),
        refreshedAt:    new Date(),
      })),
    }),
  ]);

  return { ok: true, message: `${validCities.length} cities refreshed.` };
}

// ── Single-order city resolution (3-stage fuzzy, used for single bookings) ───

export async function resolveCity(storeId, cityName) {
  const normalized = normalizeCity(cityName);
  if (!normalized) return null;

  const exact = await db.cityCache.findFirst({
    where: { storeId, nameNormalized: normalized },
  });
  if (exact) return exact;

  const startsWith = await db.cityCache.findMany({
    where: { storeId, nameNormalized: { startsWith: normalized } },
  });
  if (startsWith.length) {
    return startsWith.sort((a, b) => a.name.length - b.name.length)[0];
  }

  const contains = await db.cityCache.findMany({
    where: { storeId, nameNormalized: { contains: normalized } },
  });
  if (contains.length) {
    return contains.sort((a, b) => a.name.length - b.name.length)[0];
  }

  return null;
}

/**
 * Batch city resolution using a SINGLE DB query + in-memory matching.
 *
 * Replaces the old pattern of calling resolveCity() N times (up to 3 DB hits each).
 * For 50 orders: old = up to 150 queries, new = 1 query.
 *
 * Returns a Map<cityName, cityRecord | null> keyed by the original (un-normalized) city name.
 */
export async function batchResolveCitiesInMemory(storeId, cityNames) {
  const unique = [...new Set(cityNames.filter(Boolean))];
  if (!unique.length) return new Map();

  const allCities = await db.cityCache.findMany({ where: { storeId } });
  const result    = new Map();

  for (const name of unique) {
    result.set(name, matchCityInMemory(allCities, normalizeCity(name)));
  }

  return result;
}

function matchCityInMemory(allCities, normalized) {
  if (!normalized) return null;

  // 1. Exact
  const exact = allCities.find((c) => c.nameNormalized === normalized);
  if (exact) return exact;

  // 2. Prefix (shortest match preferred)
  const prefixMatches = allCities
    .filter((c) => c.nameNormalized.startsWith(normalized))
    .sort((a, b) => a.name.length - b.name.length);
  if (prefixMatches.length) return prefixMatches[0];

  // 3. Contains (shortest match preferred)
  const containsMatches = allCities
    .filter((c) => c.nameNormalized.includes(normalized))
    .sort((a, b) => a.name.length - b.name.length);
  if (containsMatches.length) return containsMatches[0];

  return null;
}

// ── Lookup helpers ────────────────────────────────────────────────────────────

export async function resolveCityName(storeId, leopardCityId) {
  if (!leopardCityId) return null;
  const city = await db.cityCache.findFirst({
    where: { storeId, leopardCityId: Number(leopardCityId) },
  });
  return city?.name ?? null;
}

export async function batchResolveCityNames(storeId, cityIds) {
  const unique = [...new Set((cityIds ?? []).filter(Boolean).map(Number))];
  if (!unique.length) return new Map();
  const rows = await db.cityCache.findMany({
    where:  { storeId, leopardCityId: { in: unique } },
    select: { leopardCityId: true, name: true },
  });
  const map = new Map();
  for (const row of rows) map.set(row.leopardCityId, row.name);
  return map;
}

export async function listOriginCities(storeId) {
  return db.cityCache.findMany({
    where:   { storeId, allowAsOrigin: true },
    orderBy: { name: "asc" },
  });
}

export async function getCityCacheStats(storeId) {
  const stats = await db.cityCache.aggregate({
    where: { storeId },
    _count: { _all: true },
    _max:   { refreshedAt: true },
  });
  return {
    count:           stats._count._all,
    lastRefreshedAt: stats._max.refreshedAt?.toISOString() ?? null,
  };
}
