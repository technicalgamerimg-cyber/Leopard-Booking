-- Track Shopify fulfillment writeback failures so the merchant can see which
-- booked orders failed to sync to Shopify and need manual attention.
ALTER TABLE "Shipment" ADD COLUMN "writebackFailed" BOOLEAN NOT NULL DEFAULT false;
