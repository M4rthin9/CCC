-- Slip images move out of D1 (slip_base64) and into R2. The R2 object key is
-- recorded here; slip_base64 stays for rows uploaded before the migration and
-- as the fallback path when the SLIPS binding is missing.
ALTER TABLE reservations ADD COLUMN slip_key TEXT NOT NULL DEFAULT '';
ALTER TABLE reservations_archive ADD COLUMN slip_key TEXT NOT NULL DEFAULT '';
