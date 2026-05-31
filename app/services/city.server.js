import db from "../db.server";
import { normalizeCity } from "../lib/validation.server";
import { getSettings } from "./settings.server";
import { LeopardApiClient } from "../integrations/leopards/client.server";

function extractCities(result) {
  const source = result?.data?.city_list ?? result?.raw?.city_list ?? result?.data ?? [];
  return Array.isArray(source) ? source : [];
}

export async function refreshCities(storeId) {
  const settings = await getSettings(storeId, { decrypt: true });
  const client = new LeopardApiClient({ storeId, settings });
  const result = await client.getAllCities();

  if (!result.ok) return result;

  const cities = extractCities(result);
  const validCities = cities.filter((city) => {
    const id = Number(city.id ?? city.city_id ?? city.leopard_city_id);
    const name = city.name ?? city.city_name ?? city.cityName;
    return id && name;
  });

  if (!validCities.length) {
    return { ok: false, message: "No valid cities returned by Leopards API." };
  }

  // Delete and recreate — fastest pattern for a periodic cache refresh.
  // Avoids N+1 upserts across potentially hundreds of cities.
  await db.$transaction([
    db.cityCache.deleteMany({ where: { storeId } }),
    db.cityCache.createMany({
      data: validCities.map((city) => {
        const id = Number(city.id ?? city.city_id ?? city.leopard_city_id);
        const name = city.name ?? city.city_name ?? city.cityName;
        return {
          storeId,
          leopardCityId: id,
          name,
          nameNormalized: normalizeCity(name),
          refreshedAt: new Date(),
        };
      }),
    }),
  ]);

  return { ok: true, message: `${validCities.length} cities refreshed.` };
}

export async function resolveCity(storeId, cityName) {
  const normalized = normalizeCity(cityName);
  if (!normalized) return null;

  // 1. Exact normalized match — best.
  const exact = await db.cityCache.findFirst({
    where: { storeId, nameNormalized: normalized },
  });
  if (exact) return exact;

  // 2. Prefix (startsWith) match — prefer "Lahore" over "Lahore Cantt" by sorting by name length ascending.
  const startsWith = await db.cityCache.findMany({
    where: { storeId, nameNormalized: { startsWith: normalized } },
  });
  if (startsWith.length) {
    return startsWith.sort((a, b) => a.name.length - b.name.length)[0];
  }

  // 3. Contains (last-resort fuzzy match) — also prefer the shortest match.
  const contains = await db.cityCache.findMany({
    where: { storeId, nameNormalized: { contains: normalized } },
  });
  if (contains.length) {
    return contains.sort((a, b) => a.name.length - b.name.length)[0];
  }

  return null;
}

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
    where: { storeId, leopardCityId: { in: unique } },
    select: { leopardCityId: true, name: true },
  });
  const map = new Map();
  for (const row of rows) map.set(row.leopardCityId, row.name);
  return map;
}

export async function listOriginCities(storeId) {
  return db.cityCache.findMany({
    where: { storeId, allowAsOrigin: true },
    orderBy: { name: "asc" },
  });
}

export async function getCityCacheStats(storeId) {
  const stats = await db.cityCache.aggregate({
    where: { storeId },
    _count: { _all: true },
    _max: { refreshedAt: true },
  });
  return {
    count: stats._count._all,
    lastRefreshedAt: stats._max.refreshedAt?.toISOString() ?? null,
  };
}
