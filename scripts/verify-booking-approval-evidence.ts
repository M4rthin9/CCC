import { createHash } from 'node:crypto';
import { query } from './verify-booking-charge-evidence';
import { computeApprovalTotals, parseExtraVisitorNames } from '../src/services/pricing';

const applied = await query("SELECT name FROM d1_migrations WHERE name='0026_approve_july_added_visitor.sql'");
if (applied.length) console.log('Confirmed July visitor approval already applied.');
else {
  const [row] = await query(`SELECT ref,visitDateISO,status,total,version,relation,visitorAge,extraVisitorNames,
    visitorApproved,extraVisitorApproved,extraPrisoners,bookingType,visitorCount,adultCount,child5to8Count,childUnder5Count
    FROM reservations_archive WHERE ref='VIS-37459'`);
  if (
    !row ||
    row.visitDateISO !== '2026-07-20' ||
    row.status !== 'เสร็จสิ้น' ||
    row.total !== 2000 ||
    row.version !== 1 ||
    row.visitorApproved !== 'yes' ||
    row.extraVisitorApproved !== 'yes;;' ||
    row.visitorCount !== 2 ||
    row.adultCount !== 0 ||
    row.child5to8Count !== 0 ||
    row.childUnder5Count !== 0
  )
    throw new Error('VIS-37459 changed since staff confirmation; approval stopped');
  const hash = createHash('sha256')
    .update(
      JSON.stringify([
        row.relation || '',
        row.visitorAge || '',
        row.extraVisitorNames || '',
        row.visitorApproved || '',
        row.extraVisitorApproved || '',
        row.extraPrisoners || '',
        row.bookingType || 'prisoner',
      ])
    )
    .digest('hex');
  if (
    hash !== '81d278448eea1e87635c0e8ba6e13634bfde66fa7a951db36f39b472fa0261ec' ||
    parseExtraVisitorNames(row.extraVisitorNames).length !== 2
  )
    throw new Error('VIS-37459 visitor details changed; approval stopped');
  const cost = computeApprovalTotals(
    true,
    'yes;;yes',
    String(row.extraVisitorNames),
    String(row.relation),
    String(row.visitorAge),
    String(row.extraPrisoners || '')
  );
  if (cost.total !== 3000 || cost.adultCount !== 2 || cost.childUnder5Count !== 1 || cost.visitorCount !== 3)
    throw new Error('VIS-37459 confirmed guest charge no longer matches');
  const [lock] = await query("SELECT total FROM reservation_payment_locks WHERE ref='VIS-37459'");
  if (lock?.total !== 2000) throw new Error('VIS-37459 guard changed; approval stopped');
  console.log('Confirmed additional adult verified for VIS-37459: child free, final booking charge 3,000 THB.');
}
