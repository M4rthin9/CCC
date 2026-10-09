-- Operator explicitly confirmed: VIS-65622 is correct; approve one more adult on VIS-37459.
-- No other reservation or approval changes. Deployment rechecks the exact source guest list.
CREATE TABLE booking_approval_corrections (
 ref TEXT PRIMARY KEY, fromApproval TEXT NOT NULL, toApproval TEXT NOT NULL,
 fromTotal INTEGER NOT NULL, bookingTotal INTEGER NOT NULL, expectedVersion INTEGER NOT NULL,
 fromCounters TEXT NOT NULL, toCounters TEXT NOT NULL, pricingSha256 TEXT NOT NULL,
 appliedAt TEXT NOT NULL DEFAULT ''
);
INSERT INTO booking_approval_corrections VALUES (
 'VIS-37459','yes;;','yes;;yes',2000,3000,1,
 '{"visitorCount":2,"adultCount":0,"child5to8Count":0,"childUnder5Count":0}',
 '{"visitorCount":3,"adultCount":2,"child5to8Count":0,"childUnder5Count":1}',
 '81d278448eea1e87635c0e8ba6e13634bfde66fa7a951db36f39b472fa0261ec',''
);
CREATE TABLE booking_approval_guard(valid INTEGER CHECK(valid=1));
INSERT INTO booking_approval_guard
SELECT 0 FROM reservations_archive r LEFT JOIN reservation_payment_locks l ON r.ref=l.ref
WHERE r.ref='VIS-37459' AND (
 r.visitDateISO!='2026-07-20' OR r.status!='เสร็จสิ้น' OR r.visitorApproved!='yes'
 OR r.extraVisitorApproved!='yes;;' OR r.total!=2000 OR r.version!=1
 OR r.visitorCount!=2 OR r.adultCount!=0 OR r.child5to8Count!=0 OR r.childUnder5Count!=0
 OR l.total IS NULL OR l.total!=2000
);
DROP TABLE booking_approval_guard;
INSERT INTO event_log(timestamp,username,action,targetRef,details,result)
SELECT strftime('%Y-%m-%d %H:%M:%S','now','+7 hours'),'system','booking_added_visitor_approved',ref,
 json_object('fromApproval',extraVisitorApproved,'toApproval','yes;;yes','from',total,'to',3000,
 'reason','operator confirmed additional adult attends and must be charged; child aged 1 remains free',
 'via','migration 0026'),'success'
FROM reservations_archive WHERE ref='VIS-37459';
UPDATE booking_approval_corrections SET appliedAt=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE ref IN (SELECT ref FROM reservations_archive);
UPDATE reservation_payment_locks SET total=3000 WHERE ref='VIS-37459'
AND EXISTS(SELECT 1 FROM booking_approval_corrections WHERE ref='VIS-37459' AND appliedAt!='');
UPDATE reservations_archive
SET extraVisitorApproved='yes;;yes',total=3000,visitorCount=3,adultCount=2,child5to8Count=0,childUnder5Count=1,
 version=version+1,updatedAt=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE ref='VIS-37459' AND EXISTS(SELECT 1 FROM booking_approval_corrections WHERE ref='VIS-37459' AND appliedAt!='');
DELETE FROM d1_cache WHERE key NOT LIKE 'rl:%';
UPDATE settings SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)
WHERE key IN ('data_version','data_version:reservations');
