-- Migration 0020: reprice completed bookings on the visitors approved to enter.
--
-- Reports now count only completed (เสร็จสิ้น) visits so they reconcile with the
-- bank statement. Thirteen archived bookings stored a higher total than the
-- approved visitors cost — mostly a child under 5 (free) or 5-8 (half) charged
-- as an adult in the legacy import, which made 24 Jul 2026 read 48,000 against
-- the 47,000 collected. Total, visitor count and age buckets are rewritten from
-- the approved visitors only.
--
-- Deliberately left alone: rows with an extra visitor whose approval was never
-- recorded, rows with a rejected main visitor, and rows the rules would price
-- higher — none of those can be checked against what the bank received.
-- Each update is guarded on the old total so a re-run changes nothing, and each
-- change is written to the event log first.

INSERT INTO event_log (timestamp, username, action, targetRef, details, result)
SELECT strftime('%Y-%m-%d %H:%M:%S', 'now', '+7 hours'), 'system', 'completed_total_repriced', ref,
       json_object('visitDateISO', visitDateISO, 'from', total,
                   'reason', 'priced on approved visitors only', 'via', 'migration 0020'),
       'success'
FROM reservations_archive
WHERE status = 'เสร็จสิ้น' AND ref IN ('VIS-41019', 'VIS-84786', 'VIS-65830', 'VIS-55903', 'VIS-97273', 'VIS-37212', 'VIS-13729', 'VIS-32602', 'VIS-19649', 'VIS-81233', 'VIS-59051', 'VIS-62668', 'VIS-29141');

UPDATE reservations_archive SET total = 2000, visitorCount = 2, adultCount = 1, child5to8Count = 0, childUnder5Count = 1 WHERE ref = 'VIS-41019' AND status = 'เสร็จสิ้น' AND total = 3000;
UPDATE reservations_archive SET total = 2000, visitorCount = 2, adultCount = 1, child5to8Count = 0, childUnder5Count = 1 WHERE ref = 'VIS-84786' AND status = 'เสร็จสิ้น' AND total = 3000;
UPDATE reservations_archive SET total = 2000, visitorCount = 2, adultCount = 1, child5to8Count = 0, childUnder5Count = 1 WHERE ref = 'VIS-65830' AND status = 'เสร็จสิ้น' AND total = 3000;
UPDATE reservations_archive SET total = 2500, visitorCount = 2, adultCount = 1, child5to8Count = 1, childUnder5Count = 0 WHERE ref = 'VIS-55903' AND status = 'เสร็จสิ้น' AND total = 3000;
UPDATE reservations_archive SET total = 3500, visitorCount = 3, adultCount = 2, child5to8Count = 1, childUnder5Count = 0 WHERE ref = 'VIS-97273' AND status = 'เสร็จสิ้น' AND total = 4000;
UPDATE reservations_archive SET total = 2500, visitorCount = 2, adultCount = 1, child5to8Count = 1, childUnder5Count = 0 WHERE ref = 'VIS-37212' AND status = 'เสร็จสิ้น' AND total = 3000;
UPDATE reservations_archive SET total = 2000, visitorCount = 1, adultCount = 1, child5to8Count = 0, childUnder5Count = 0 WHERE ref = 'VIS-13729' AND status = 'เสร็จสิ้น' AND total = 3000;
UPDATE reservations_archive SET total = 2500, visitorCount = 2, adultCount = 1, child5to8Count = 1, childUnder5Count = 0 WHERE ref = 'VIS-32602' AND status = 'เสร็จสิ้น' AND total = 3000;
UPDATE reservations_archive SET total = 2500, visitorCount = 2, adultCount = 1, child5to8Count = 1, childUnder5Count = 0 WHERE ref = 'VIS-19649' AND status = 'เสร็จสิ้น' AND total = 3000;
UPDATE reservations_archive SET total = 2000, visitorCount = 2, adultCount = 1, child5to8Count = 0, childUnder5Count = 1 WHERE ref = 'VIS-81233' AND status = 'เสร็จสิ้น' AND total = 3000;
UPDATE reservations_archive SET total = 2000, visitorCount = 2, adultCount = 1, child5to8Count = 0, childUnder5Count = 1 WHERE ref = 'VIS-59051' AND status = 'เสร็จสิ้น' AND total = 3000;
UPDATE reservations_archive SET total = 2000, visitorCount = 2, adultCount = 1, child5to8Count = 0, childUnder5Count = 1 WHERE ref = 'VIS-62668' AND status = 'เสร็จสิ้น' AND total = 3000;
UPDATE reservations_archive SET total = 2000, visitorCount = 1, adultCount = 1, child5to8Count = 0, childUnder5Count = 0 WHERE ref = 'VIS-29141' AND status = 'เสร็จสิ้น' AND total = 3000;
