-- Migration: 0020_ad_spend_daily_launch_fk
-- Adds FK constraint from ad_spend_daily.launch_id → launches(id).
-- Deferred from T-1-010 (launches table ran in parallel at the time).
--
-- NOT VALID: skips validation of existing rows (safe for large tables in prod).
-- VALIDATE CONSTRAINT: runs separately to avoid long lock; in dev with no data
--   both statements run in the same migration.
--
-- ON DELETE RESTRICT: prevents deleting a launch that has spend rows.

-- Step 1: add constraint without validating existing rows
ALTER TABLE ad_spend_daily
  ADD CONSTRAINT fk_ad_spend_daily_launch
  FOREIGN KEY (launch_id)
  REFERENCES launches(id)
  ON DELETE RESTRICT
  NOT VALID;

-- Step 2: validate (acquires ShareUpdateExclusiveLock, not AccessExclusiveLock)
ALTER TABLE ad_spend_daily
  VALIDATE CONSTRAINT fk_ad_spend_daily_launch;

-- Down:
-- ALTER TABLE ad_spend_daily DROP CONSTRAINT fk_ad_spend_daily_launch;
