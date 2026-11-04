-- Reusable individual decisions are scoped to visitor ID + primary prisoner ID.
-- Keep the decision independently of booking archiving/deletion. No booking,
-- price, attendance or payment record is rewritten by this migration.
CREATE TABLE visitor_clearances (
  prisonerId TEXT NOT NULL CHECK (prisonerId != ''),
  visitorId TEXT NOT NULL CHECK (visitorId != ''),
  decision TEXT NOT NULL CHECK (decision IN ('yes', 'no')),
  sourceRef TEXT NOT NULL,
  decidedBy TEXT NOT NULL,
  decidedAt TEXT NOT NULL,
  PRIMARY KEY (prisonerId, visitorId)
);

-- Recover individual decisions and explicit participant-stage approvals. A
-- rejected guest stays rejected even when the rest of the party passed. TBL
-- auto-approval and payment alone never establish reusable visitor clearance.
WITH RECURSIVE
bookings AS (
  SELECT ref, prisonerId, visitorId, visitorApproved, extraVisitorNames, extraVisitorApproved, participantApproved,
    COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', NULLIF(updatedAt, '')),
      strftime('%Y-%m-%dT%H:%M:%fZ', NULLIF(createdAt, '')),
      strftime('%Y-%m-%dT%H:%M:%fZ', visitDateISO), '') AS decidedAt
  FROM reservations WHERE bookingType != 'table' AND upper(ref) NOT LIKE 'TBL-%'
  UNION ALL
  SELECT ref, prisonerId, visitorId, visitorApproved, extraVisitorNames, extraVisitorApproved, participantApproved,
    COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', NULLIF(updatedAt, '')),
      strftime('%Y-%m-%dT%H:%M:%fZ', NULLIF(createdAt, '')),
      strftime('%Y-%m-%dT%H:%M:%fZ', visitDateISO), '')
  FROM reservations_archive WHERE bookingType != 'table' AND upper(ref) NOT LIKE 'TBL-%'
),
extras(ref, prisonerId, decidedAt, participantApproved, guest, decision, remainingGuests, remainingDecisions) AS (
  SELECT ref, prisonerId, decidedAt, participantApproved, '', '', extraVisitorNames || ';;', extraVisitorApproved || ';;'
  FROM bookings WHERE extraVisitorNames != ''
  UNION ALL
  SELECT ref, prisonerId, decidedAt, participantApproved,
    substr(remainingGuests, 1, instr(remainingGuests, ';;') - 1),
    substr(remainingDecisions, 1, instr(remainingDecisions, ';;') - 1),
    substr(remainingGuests, instr(remainingGuests, ';;') + 2),
    CASE WHEN instr(remainingDecisions, ';;') > 0
      THEN substr(remainingDecisions, instr(remainingDecisions, ';;') + 2) ELSE '' END
  FROM extras WHERE remainingGuests != ''
),
decisions AS (
  SELECT ref, upper(trim(prisonerId)) AS prisonerId, upper(trim(visitorId)) AS visitorId,
    CASE WHEN lower(trim(visitorApproved)) IN ('yes', 'no') THEN lower(trim(visitorApproved))
      WHEN participantApproved = 'yes' THEN 'yes' ELSE '' END AS decision, decidedAt FROM bookings
  UNION ALL
  SELECT ref, upper(trim(prisonerId)),
    upper(trim(substr(substr(guest, instr(guest, '|') + 1), 1,
      instr(substr(guest, instr(guest, '|') + 1) || '|', '|') - 1))),
    CASE WHEN lower(trim(decision)) IN ('yes', 'no') THEN lower(trim(decision))
      WHEN participantApproved = 'yes' THEN 'yes' ELSE '' END, decidedAt
  FROM extras WHERE instr(guest, '|') > 1
),
ranked AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY prisonerId, visitorId
    ORDER BY decidedAt DESC, (decision = 'no') DESC, ref DESC
  ) AS position
  FROM decisions WHERE prisonerId != '' AND visitorId != '' AND decision IN ('yes', 'no')
)
INSERT INTO visitor_clearances (prisonerId, visitorId, decision, sourceRef, decidedBy, decidedAt)
SELECT prisonerId, visitorId, decision, ref, 'legacy', decidedAt FROM ranked WHERE position = 1;
