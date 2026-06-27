-- Change the default value for leopardEnvironment from 'staging' to 'production'.
-- Leopards staging is no longer supported; all new Settings rows must default to production.
-- Existing rows with 'staging' are handled by the self-healing migration in getSettings().
ALTER TABLE "Settings" ALTER COLUMN "leopardEnvironment" SET DEFAULT 'production';
