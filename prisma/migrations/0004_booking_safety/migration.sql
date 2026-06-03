-- Migration 0004: Booking Safety
-- Adds optimistic booking lock, loadsheet dedup constraint, and webhook dedup index.

-- 1. Booking lock field (prevents TOCTOU race conditions)
ALTER TABLE "Shipment" ADD COLUMN IF NOT EXISTS "bookingLockedAt" TIMESTAMP(3);

-- 2. Unique constraint on Loadsheet (prevents duplicate loadsheets from double-click)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Loadsheet_storeId_loadSheetId_key'
  ) THEN
    ALTER TABLE "Loadsheet" ADD CONSTRAINT "Loadsheet_storeId_loadSheetId_key" UNIQUE ("storeId", "loadSheetId");
  END IF;
END $$;

-- 3. Index on WebhookLog for fast deduplication lookups
CREATE INDEX IF NOT EXISTS "WebhookLog_topic_payloadDigest_idx"
  ON "WebhookLog"("topic", "payloadDigest");
