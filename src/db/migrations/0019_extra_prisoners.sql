-- 0019: more than one prisoner at a visit table.
--
-- A Superadmin can add prisoners to an existing visit booking, e.g. a father
-- and son held in the same prison who want to sit at the same table. They are
-- prisoners, not visitors (ญาติ), so they get their own column instead of a
-- row in extraVisitorNames: reports count them with the prisoners, and each is
-- charged the prisoner fee.
--
-- extraPrisoners — `name|prisonerId|wing` rows joined by `;;`. '' = only the
--                  main prisoner (prisonerName/prisonerId/wing).
ALTER TABLE reservations         ADD COLUMN extraPrisoners TEXT NOT NULL DEFAULT '';
-- The archive must stay column-identical: the sweep copies RESERVATION_WRITABLE_COLUMNS.
ALTER TABLE reservations_archive ADD COLUMN extraPrisoners TEXT NOT NULL DEFAULT '';
