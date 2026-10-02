-- Migration 0018: restore eight archived bookings that were overwritten, and
-- give five archived bookings a ref of their own.
--
-- Booking refs (VIS- plus five random digits) were checked against the live
-- table only, so a later booking could reuse the ref of an archived one. The
-- archive sweep copied rows with INSERT OR REPLACE, so when such a later
-- booking was archived (the 2026-10-01 sweep) it overwrote the older booking.
-- The eight below come back from the D1 backup taken on 2026-08-18
-- (data/backup-pre-import.sql), unchanged except for the ref: "-A" is added,
-- because the original ref now belongs to the later booking.
--
-- Five archived bookings share their ref with a live October booking. The
-- dashboard's merge keeps the live row, which hid them, and the next sweep
-- would have overwritten them. Their ref gets "-A" as well; the live bookings
-- keep theirs, since families hold those numbers.
--
-- Code in the same release keeps refs unique across the live table and the
-- archive, and the sweep no longer overwrites an archived row.

-- VIS-70822 · 2026-05-28 · ชัญญาพัชญ์ ญาณโชติสิทธินนท์
INSERT INTO reservations_archive ("ref","timestamp","visitorName","visitorId","visitorPhone","relation","religion","allergy","extraVisitorReligions","extraVisitorAllergies","extraVisitorNames","visitorApproved","extraVisitorApproved","prisonerName","prisonerId","wing","visitDate","visitDateISO","visitorCount","totalPersons","total","adultCount","child5to8Count","childUnder5Count","status","slipImage","slip_base64","cancelReason","createdAt","updatedAt","version","createdBy","archivedAt","source","slip_verify_status","slip_verify_json","slip_verify_at","slip_fingerprint","slip_image_hash","payment_ref1","visitorAge") VALUES('VIS-70822-A','25/5/2569 21:05:27','ชัญญาพัชญ์ ญาณโชติสิทธินนท์','1909900357612','650415888','แฟน/ภรรยา','','','','','','yes','','ณัฐพงษ์ มะลิแย้ม','6850109158','แดน 5','วันพฤหัสบดีที่ 28 พฤษภาคม 2569','2026-05-28',1,2,2000,0,0,0,'เสร็จสิ้น','https://drive.google.com/thumbnail?id=1JptxtNBXEz5c4P49bDYY0A6TTKAq_cYM&sz=w1200','','','2026-07-31T03:11:10.752Z','2026-07-31T03:11:10.752Z',1,'legacy','','','','','','','','','');
-- VIS-33296 · 2026-06-25 · Nasra khan
INSERT INTO reservations_archive ("ref","timestamp","visitorName","visitorId","visitorPhone","relation","religion","allergy","extraVisitorReligions","extraVisitorAllergies","extraVisitorNames","visitorApproved","extraVisitorApproved","prisonerName","prisonerId","wing","visitDate","visitDateISO","visitorCount","totalPersons","total","adultCount","child5to8Count","childUnder5Count","status","slipImage","slip_base64","cancelReason","createdAt","updatedAt","version","createdBy","archivedAt","source","slip_verify_status","slip_verify_json","slip_verify_at","slip_fingerprint","slip_image_hash","payment_ref1","visitorAge") VALUES('VIS-33296-A','13/6/2569 9:13:35','Nasra khan','123417219','447793555441','Father / Mother','','','','','','','','มูฮัมหมัด ซุฟยาน ข่าน MUHAMMAD SOFYAAN KHAN','6850108260','แดน 11','วันพฤหัสบดีที่ 25 มิถุนายน 2569','2026-06-25',1,2,2000,0,0,0,'เสร็จสิ้น','','','','2026-07-31T03:11:10.753Z','2026-07-31T03:11:10.753Z',1,'legacy','','','','','','','','','');
-- VIS-42941 · 2026-06-29 · ประภา เตริญรัตน์
INSERT INTO reservations_archive ("ref","timestamp","visitorName","visitorId","visitorPhone","relation","religion","allergy","extraVisitorReligions","extraVisitorAllergies","extraVisitorNames","visitorApproved","extraVisitorApproved","prisonerName","prisonerId","wing","visitDate","visitDateISO","visitorCount","totalPersons","total","adultCount","child5to8Count","childUnder5Count","status","slipImage","slip_base64","cancelReason","createdAt","updatedAt","version","createdBy","archivedAt","source","slip_verify_status","slip_verify_json","slip_verify_at","slip_fingerprint","slip_image_hash","payment_ref1","visitorAge") VALUES('VIS-42941-A','15/6/2569 14:57:51','ประภา เตริญรัตน์','3649800088023','827013158','แฟน/ภรรยา','','','','','','yes','','ศราวุธ เอราวัณมงคล','6850100947','แดน 7','วันจันทร์ที่ 29 มิถุนายน 2569','2026-06-29',1,2,2000,0,0,0,'เสร็จสิ้น','https://drive.google.com/thumbnail?id=18Zmru_2ppcQpOCy_z4qgpuWdewUR9JMj&sz=w1200','','','2026-07-31T03:11:10.754Z','2026-07-31T03:11:10.754Z',1,'legacy','','','','','','','','','');
-- VIS-75118 · 2026-07-07 · วาทินี มุ่งหมาย
INSERT INTO reservations_archive ("ref","timestamp","visitorName","visitorId","visitorPhone","relation","religion","allergy","extraVisitorReligions","extraVisitorAllergies","extraVisitorNames","visitorApproved","extraVisitorApproved","prisonerName","prisonerId","wing","visitDate","visitDateISO","visitorCount","totalPersons","total","adultCount","child5to8Count","childUnder5Count","status","slipImage","slip_base64","cancelReason","createdAt","updatedAt","version","createdBy","archivedAt","source","slip_verify_status","slip_verify_json","slip_verify_at","slip_fingerprint","slip_image_hash","payment_ref1","visitorAge") VALUES('VIS-75118-A','26/6/2569 17:06:26','วาทินี มุ่งหมาย','1100300074759','631801872','แฟน/ภรรยา','','','','','','yes','','สุวิทย์ สมคิด','6950100665','แดน 8','วันอังคารที่ 7 กรกฎาคม 2569','2026-07-07',1,2,2000,0,0,0,'เสร็จสิ้น','https://drive.google.com/thumbnail?id=1sd2Ynw63s88n37-CbakuojF7mI4NrAbr&sz=w1200','','','2026-07-31T03:11:10.754Z','2026-07-31T03:11:10.754Z',1,'legacy','','','','','','','','','');
-- VIS-99948 · 2026-07-09 · มุจรินทร์ ท่าไคร้กลาง
INSERT INTO reservations_archive ("ref","timestamp","visitorName","visitorId","visitorPhone","relation","religion","allergy","extraVisitorReligions","extraVisitorAllergies","extraVisitorNames","visitorApproved","extraVisitorApproved","prisonerName","prisonerId","wing","visitDate","visitDateISO","visitorCount","totalPersons","total","adultCount","child5to8Count","childUnder5Count","status","slipImage","slip_base64","cancelReason","createdAt","updatedAt","version","createdBy","archivedAt","source","slip_verify_status","slip_verify_json","slip_verify_at","slip_fingerprint","slip_image_hash","payment_ref1","visitorAge") VALUES('VIS-99948-A','8/7/2569 11:48:15','มุจรินทร์ ท่าไคร้กลาง','1451000036183','829966977','พี่ / น้อง','','','','','','yes','','ฐาพล เจริญยิ่ง','2223/66','แดน 10','วันพฤหัสบดีที่ 9 กรกฎาคม 2569','2026-07-09',1,2,2000,0,0,0,'เสร็จสิ้น','https://drive.google.com/thumbnail?id=1OSgrc51zbc2VFt1OysbLkHBex6XroQhv&sz=w1200','','','2026-07-31T03:11:10.755Z','2026-07-31T03:11:10.755Z',1,'legacy','','','','','','','','','');
-- VIS-70603 · 2026-07-14 · Tran thi que trang
INSERT INTO reservations_archive ("ref","timestamp","visitorName","visitorId","visitorPhone","relation","religion","allergy","extraVisitorReligions","extraVisitorAllergies","extraVisitorNames","visitorApproved","extraVisitorApproved","prisonerName","prisonerId","wing","visitDate","visitDateISO","visitorCount","totalPersons","total","adultCount","child5to8Count","childUnder5Count","status","slipImage","slip_base64","cancelReason","createdAt","updatedAt","version","createdBy","archivedAt","source","slip_verify_status","slip_verify_json","slip_verify_at","slip_fingerprint","slip_image_hash","payment_ref1","visitorAge") VALUES('VIS-70603-A','30/6/2569 11:39:24','Tran thi que trang','N2131429','658474679','Brother / Sister','','','','','Nguyen Thi Thu|C4277965|Father / Mother|','yes','yes','เท ดุย ทราน Tran The Duy','2870/68','แดน 11','วันอังคารที่ 14 กรกฎาคม 2569','2026-07-14',2,3,3000,0,0,0,'ยกเลิก','','','','2026-07-31T03:11:10.754Z','2026-07-31T03:11:10.754Z',1,'legacy','','','','','','','','','');
-- VIS-35223 · 2026-07-15 · ชลธิชา คนอ้วน
INSERT INTO reservations_archive ("ref","timestamp","visitorName","visitorId","visitorPhone","relation","religion","allergy","extraVisitorReligions","extraVisitorAllergies","extraVisitorNames","visitorApproved","extraVisitorApproved","prisonerName","prisonerId","wing","visitDate","visitDateISO","visitorCount","totalPersons","total","adultCount","child5to8Count","childUnder5Count","status","slipImage","slip_base64","cancelReason","createdAt","updatedAt","version","createdBy","archivedAt","source","slip_verify_status","slip_verify_json","slip_verify_at","slip_fingerprint","slip_image_hash","payment_ref1","visitorAge") VALUES('VIS-35223-A','1/7/2569 16:47:45','ชลธิชา คนอ้วน','1570501303271','837570644','แฟน/ภรรยา','','','','','','yes','','จิณณวัตร อติเภตรา','6950101714','แดน 11','วันพุธที่ 15 กรกฎาคม 2569','2026-07-15',1,2,2000,0,0,0,'เสร็จสิ้น','https://drive.google.com/thumbnail?id=134kqvHsogqKXoe0X-YvbSMJqiHBgVG9d&sz=w1200','','','2026-07-31T03:11:10.754Z','2026-07-31T03:11:10.754Z',1,'legacy','','','','','','','','','');
-- VIS-66608 · 2026-07-27 · วรรณวิศา บุญจิตร
INSERT INTO reservations_archive ("ref","timestamp","visitorName","visitorId","visitorPhone","relation","religion","allergy","extraVisitorReligions","extraVisitorAllergies","extraVisitorNames","visitorApproved","extraVisitorApproved","prisonerName","prisonerId","wing","visitDate","visitDateISO","visitorCount","totalPersons","total","adultCount","child5to8Count","childUnder5Count","status","slipImage","slip_base64","cancelReason","createdAt","updatedAt","version","createdBy","archivedAt","source","slip_verify_status","slip_verify_json","slip_verify_at","slip_fingerprint","slip_image_hash","payment_ref1","visitorAge") VALUES('VIS-66608-A','13/7/2569 7:28:50','วรรณวิศา บุญจิตร','1209700458528','0638597736','แฟน/ภรรยา','อิสลาม','ไม่มี','','','','yes','','ซามีส เกตุเลขา','4206/62','แดน 10','วันจันทร์ที่ 27 กรกฎาคม 2569','2026-07-27',1,2,2000,1,0,0,'เสร็จสิ้น','https://drive.google.com/thumbnail?id=1nlUPz5nPClBW3mPHJdTPJv7nKmCkHADT&sz=w1200','','','2026-07-31T03:11:10.755Z','2026-07-31T03:11:10.755Z',1,'legacy','','','','','','','','','');

-- The only note on these refs (14 Jul, "ไม่ชำระเงินตามเวลากำหนด") belongs to the
-- cancelled July booking, not to the September booking that now holds VIS-70603.
UPDATE notes SET ref = 'VIS-70603-A' WHERE ref = 'VIS-70603' AND timestamp LIKE '%/7/2569%';

-- Hidden archived bookings, each matched on its visit date and only while the
-- live booking with the same ref exists.
UPDATE reservations_archive
   SET ref = ref || '-A', updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), version = version + 1
 WHERE (ref, visitDateISO) IN (VALUES ('VIS-23574', '2026-06-09'), ('VIS-14555', '2026-06-24'), ('VIS-20345', '2026-07-23'), ('VIS-89538', '2026-08-31'), ('VIS-40891', '2026-09-07'))
   AND ref IN (SELECT ref FROM reservations);

-- Audit trail and a note on each booking, so the "-A" explains itself in the dashboard.
INSERT INTO event_log (timestamp, username, action, targetRef, details, result)
SELECT strftime('%Y-%m-%d %H:%M:%S', 'now', '+7 hours'), 'system', 'archived_booking_restored', ref,
       json_object('originalRef', substr(ref, 1, length(ref) - 2), 'visitDateISO', visitDateISO,
                   'status', status, 'total', total, 'source', 'backup 2026-08-18', 'via', 'migration 0018'),
       'success'
FROM reservations_archive WHERE ref IN ('VIS-70822-A', 'VIS-33296-A', 'VIS-42941-A', 'VIS-75118-A', 'VIS-99948-A', 'VIS-70603-A', 'VIS-35223-A', 'VIS-66608-A');

INSERT INTO event_log (timestamp, username, action, targetRef, details, result)
SELECT strftime('%Y-%m-%d %H:%M:%S', 'now', '+7 hours'), 'system', 'archived_booking_ref_changed', ref,
       json_object('from', substr(ref, 1, length(ref) - 2), 'to', ref,
                   'reason', 'ref also used by a live booking', 'via', 'migration 0018'),
       'success'
FROM reservations_archive WHERE ref IN ('VIS-23574-A', 'VIS-14555-A', 'VIS-20345-A', 'VIS-89538-A', 'VIS-40891-A');

INSERT INTO notes (ref, text, user, timestamp, createdAt)
SELECT ref,
       'กู้คืนจากข้อมูลสำรองวันที่ 18 ส.ค. 2569 · เลขเดิม ' || substr(ref, 1, length(ref) - 2) ||
       ' ถูกใช้ซ้ำโดยการจองภายหลังและถูกเขียนทับเมื่อย้ายเข้าคลังวันที่ 1 ต.ค. 2569 จึงเพิ่ม -A ต่อท้ายเลขอ้างอิง',
       'system', CAST(strftime('%d', 'now', '+7 hours') AS INTEGER) || '/' || CAST(strftime('%m', 'now', '+7 hours') AS INTEGER) || '/' || (CAST(strftime('%Y', 'now', '+7 hours') AS INTEGER) + 543) || ' ' || strftime('%H:%M:%S', 'now', '+7 hours'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM reservations_archive WHERE ref IN ('VIS-70822-A', 'VIS-33296-A', 'VIS-42941-A', 'VIS-75118-A', 'VIS-99948-A', 'VIS-70603-A', 'VIS-35223-A', 'VIS-66608-A');

INSERT INTO notes (ref, text, user, timestamp, createdAt)
SELECT ref,
       'เปลี่ยนเลขอ้างอิงจาก ' || substr(ref, 1, length(ref) - 2) || ' เป็น ' || ref ||
       ' เพราะเลขเดิมซ้ำกับการจองใหม่ (ตุลาคม 2569)',
       'system', CAST(strftime('%d', 'now', '+7 hours') AS INTEGER) || '/' || CAST(strftime('%m', 'now', '+7 hours') AS INTEGER) || '/' || (CAST(strftime('%Y', 'now', '+7 hours') AS INTEGER) + 543) || ' ' || strftime('%H:%M:%S', 'now', '+7 hours'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM reservations_archive WHERE ref IN ('VIS-23574-A', 'VIS-14555-A', 'VIS-20345-A', 'VIS-89538-A', 'VIS-40891-A');

-- Fresh lists for open dashboards.
DELETE FROM d1_cache WHERE key NOT LIKE 'rl:%';
UPDATE settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
WHERE key IN ('data_version', 'data_version:reservations');
