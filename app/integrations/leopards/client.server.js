import db from "../../db.server";

const JSON_ENDPOINT_TIMEOUT = Number(process.env.LEOPARDS_REQUEST_TIMEOUT_MS ?? 15000);
const PDF_ENDPOINT_TIMEOUT = Number(process.env.LEOPARDS_PDF_TIMEOUT_MS ?? 30000);
const MAX_RETRIES = 3;

function resolveBaseUrl(environment) {
  if (environment === "production") {
    return (
      process.env.LEOPARDS_API_BASE_URL_PROD ??
      "https://merchantapi.leopardscourier.com/api/"
    );
  }
  return (
    process.env.LEOPARDS_API_BASE_URL_STAGING ??
    "https://merchantapistaging.leopardscourier.com/api/"
  );
}

function stringifyError(error) {
  if (!error) return "Unknown Leopards API error";
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Unexpected Leopards API error";
  }
}

function normalizeJson(endpoint, response, httpStatus) {
  const leopardStatus = Number(response?.status);
  const success = leopardStatus === 1 || response?.status === "1";

  if (success) {
    return {
      ok: true,
      data: response?.data ?? response,
      raw: response,
      httpStatus,
      leopardStatus: 1,
    };
  }

  return {
    ok: false,
    code: `LEOPARDS_${endpoint.toUpperCase()}_FAILED`,
    message: stringifyError(response?.error ?? response?.message),
    fieldErrors:
      typeof response?.error === "object" ? response.error : undefined,
    raw: response,
    httpStatus,
    leopardStatus: Number.isFinite(leopardStatus) ? leopardStatus : null,
  };
}

function encodeFormBody(payload) {
  const body = new URLSearchParams();

  for (const [key, value] of Object.entries(payload)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        body.append(`${key}[]`, String(item ?? ""));
      }
    } else if (value !== null && typeof value === "object") {
      body.append(key, JSON.stringify(value));
    } else {
      body.append(key, String(value ?? ""));
    }
  }

  return body.toString();
}

function encodeJsonBody(payload) {
  return JSON.stringify(payload);
}

export class LeopardApiClient {
  constructor({ storeId, settings }) {
    this.storeId = storeId;
    this.settings = settings;
    this.baseUrl = resolveBaseUrl(settings.leopardEnvironment);
  }

  credentials() {
    return {
      api_key: this.settings.leopardApiKey,
      api_password: this.settings.leopardApiPassword,
    };
  }

  async requestGet(endpoint) {
    const timeoutMs = JSON_ENDPOINT_TIMEOUT;
    let httpStatus = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${this.baseUrl}${endpoint}`, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        httpStatus = response.status;
        if (response.status >= 500 && attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
          continue;
        }
        const text = await response.text();
        const json = text ? JSON.parse(text) : {};
        const result = normalizeJson(endpoint, json, httpStatus);
        await this.logCall(endpoint, result, 0, attempt);
        return result;
      } catch (error) {
        if (attempt < MAX_RETRIES - 1 && error.name !== "AbortError") continue;
        const result = {
          ok: false,
          code: "LEOPARDS_NETWORK_ERROR",
          message: error.name === "AbortError" ? "Request timed out" : error.message,
          httpStatus,
          leopardStatus: null,
        };
        await this.logCall(endpoint, result, 0, attempt);
        return result;
      } finally {
        clearTimeout(timeoutId);
      }
    }
  }

  async request(endpoint, payload = {}, options = {}) {
    const startedAt = Date.now();
    const timeoutMs = options.pdf ? PDF_ENDPOINT_TIMEOUT : JSON_ENDPOINT_TIMEOUT;
    let httpStatus = null;
    let retryCount = 0;
    let result;

    const { api_key, api_password } = this.credentials();
    const qs = new URLSearchParams({ api_key, api_password }).toString();
    const body = options.json
      ? encodeJsonBody(payload)
      : encodeFormBody(payload);

    const contentType = options.json
      ? "application/json"
      : "application/x-www-form-urlencoded";

    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      retryCount = attempt;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(`${this.baseUrl}${endpoint}?${qs}`, {
          method: "POST",
          headers: {
            Accept: options.pdf
              ? "application/pdf,application/json"
              : "application/json",
            "Content-Type": contentType,
          },
          body,
          signal: controller.signal,
        });
        httpStatus = response.status;

        if (response.status >= 500 && attempt < MAX_RETRIES - 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, 1000 * 2 ** attempt),
          );
          continue;
        }

        const responseContentType = response.headers.get("content-type") ?? "";
        if (options.pdf && responseContentType.includes("application/pdf")) {
          result = {
            ok: true,
            data: Buffer.from(await response.arrayBuffer()),
            httpStatus,
            leopardStatus: 1,
          };
          break;
        }

        const text = await response.text();
        const json = text ? JSON.parse(text) : {};
        result = normalizeJson(endpoint, json, httpStatus);
        break;
      } catch (error) {
        if (attempt < MAX_RETRIES - 1 && error.name !== "AbortError") continue;
        result = {
          ok: false,
          code: "LEOPARDS_NETWORK_ERROR",
          message:
            error.name === "AbortError"
              ? "Leopards API request timed out"
              : error.message,
          httpStatus,
          leopardStatus: null,
        };
        break;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    await this.logCall(endpoint, result, Date.now() - startedAt, retryCount);
    return result;
  }

  async logCall(endpoint, result, latencyMs, retryCount) {
    try {
      await db.apiLog.create({
        data: {
          storeId: this.storeId,
          endpoint,
          httpStatus: result?.httpStatus ?? null,
          leopardStatus: result?.leopardStatus ?? null,
          latencyMs,
          retryCount,
          success: Boolean(result?.ok),
          error: result?.ok ? null : result?.message?.slice(0, 1000),
        },
      });
    } catch (err) {
      console.error("[LeopardApiClient] Failed to write API log:", err);
    }
  }

  getAllCities() {
    const { api_key, api_password } = this.credentials();
    const qs = new URLSearchParams({ api_key, api_password }).toString();
    return this.requestGet(`getAllCities/format/json/?${qs}`);
  }

  bookPacket(payload) {
    return this.request("bookPacket/format/json/", payload);
  }

  batchBookPacket(packets) {
    // Leopards' batch endpoint expects the packet list as JSON in the body,
    // not URL-encoded. Send `application/json` so the array is parsed correctly.
    return this.request(
      "batchBookPacketv2/format/json/",
      { packets },
      { json: true },
    );
  }

  cancelBookedPackets(cnNumbers) {
    return this.request("cancelBookedPackets/format/json/", {
      cn_numbers: cnNumbers.join(","),
    });
  }

  generateLoadSheet(cnNumbers, courierName = "Leopards Courier", courierCode = "LCS") {
    // Array values are sent as repeated `cn_numbers[]` params by the
    // form-body encoder so Leopards parses them as a list, not a string.
    return this.request("generateLoadSheet/format/json/", {
      cn_numbers: cnNumbers,
      courier_name: courierName,
      courier_code: courierCode,
    });
  }

  downloadLoadSheet(loadSheetId) {
    // Leopards downloadLoadSheet requires credentials in the JSON body, not query params.
    const { api_key, api_password } = this.credentials();
    return this.requestPdfJson("downloadLoadSheet/", {
      api_key,
      api_password,
      load_sheet_id: loadSheetId,
      response_type: "PDF",
    });
  }

  async requestPdfJson(endpoint, payload) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PDF_ENDPOINT_TIMEOUT);
    let httpStatus = null;
    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/pdf,application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      httpStatus = response.status;
      const ct = response.headers.get("content-type") ?? "";
      if (ct.includes("application/pdf")) {
        const result = { ok: true, data: Buffer.from(await response.arrayBuffer()), httpStatus, leopardStatus: 1 };
        await this.logCall(endpoint, result, 0, 0);
        return result;
      }
      const text = await response.text();
      const json = text ? JSON.parse(text) : {};
      const result = normalizeJson(endpoint, json, httpStatus);
      await this.logCall(endpoint, result, 0, 0);
      return result;
    } catch (error) {
      const result = {
        ok: false,
        code: "LEOPARDS_NETWORK_ERROR",
        message: error.name === "AbortError" ? "Leopards API request timed out" : error.message,
        httpStatus,
        leopardStatus: null,
      };
      await this.logCall(endpoint, result, 0, 0);
      return result;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  getBookedPacketLastStatus(fromDate, toDate) {
    return this.request("getBookedPacketLastStatus/format/json/", {
      from_date: fromDate,
      to_date: toDate,
    });
  }

  trackBookedPacket(cnNumbers) {
    return this.request("trackBookedPacket/format/json/", {
      track_numbers: cnNumbers.join(","),
    });
  }
}
