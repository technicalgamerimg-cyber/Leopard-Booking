import { createHash } from "crypto";
import db from "../db.server";

/**
 * Wraps a webhook handler with idempotency via WebhookLog.
 *
 * Flow:
 *  1. Hash the raw payload.
 *  2. If a "processed" record with the same topic+hash exists → return early (duplicate).
 *  3. Otherwise, write a "received" log, run the handler, then mark "processed".
 *  4. On handler error → mark "failed" and rethrow (Shopify will retry; the next attempt
 *     will also not find a "processed" record so it will try again — correct behavior).
 *
 * @param {string|null} storeId   - Store DB id (null if store not yet resolved)
 * @param {string}      topic     - Shopify topic, e.g. "ORDERS_CREATE"
 * @param {object}      payload   - Raw webhook payload object
 * @param {Function}    handler   - Async function containing the actual business logic
 */
export async function withWebhookDedup(storeId, topic, payload, handler) {
  const digest = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");

  // Fast-path: check for an already-processed record
  const existing = await db.webhookLog.findFirst({
    where: {
      topic,
      payloadDigest: digest,
      processingStatus: "processed",
      ...(storeId ? { storeId } : {}),
    },
    select: { id: true },
  });

  if (existing) {
    console.log(
      `[webhook-dedup] Skipping duplicate ${topic} payload (digest: ${digest.slice(0, 8)}…)`,
    );
    return; // idempotent — nothing to do
  }

  // Create audit log entry
  let logId = null;
  try {
    const log = await db.webhookLog.create({
      data: {
        storeId: storeId ?? null,
        topic,
        payloadDigest: digest,
        hmacValid: true,
        processingStatus: "received",
      },
    });
    logId = log.id;
  } catch {
    // Log creation failure should not block processing
  }

  try {
    await handler();
    if (logId) {
      await db.webhookLog.update({
        where: { id: logId },
        data: { processingStatus: "processed" },
      });
    }
  } catch (err) {
    if (logId) {
      await db.webhookLog
        .update({
          where: { id: logId },
          data: {
            processingStatus: "failed",
            error: err.message?.slice(0, 1000),
          },
        })
        .catch(() => {});
    }
    throw err;
  }
}
