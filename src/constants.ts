export const TABLES = {
  reservations: 'reservations',
  archive: 'reservations_archive',
  prisoners: 'prisoners',
  users: 'users',
  roles: 'roles',
  eventLog: 'event_log',
  notes: 'notes',
  settings: 'settings',
  refreshTokens: 'refresh_tokens',
} as const;

export const ARCHIVE_MONTHS = 3;

export const AVAILABLE_PERMISSIONS = [
  'approve',
  'reject',
  'approve_discipline',
  'reject_discipline',
  'approve_participant',
  'cancel',
  'confirm_payment',
  'create_booking',
  'export',
  'manage_users',
  'manage_settings',
  'print',
  'reject_payment',
  'view_detail',
  'view_eventlog',
  'view_slip',
  'visitor_approval',
] as const;

export type Permission = (typeof AVAILABLE_PERMISSIONS)[number];

export const PERMISSIONS: Record<string, readonly Permission[]> = {
  Superadmin: [
    'approve',
    'reject',
    'approve_discipline',
    'reject_discipline',
    'approve_participant',
    'confirm_payment',
    'reject_payment',
    'cancel',
    'create_booking',
    'visitor_approval',
    'view_slip',
    'view_detail',
    'export',
    'print',
    'manage_users',
    'manage_settings',
    'view_eventlog',
  ],
  Admin: [
    'approve',
    'reject',
    'approve_discipline',
    'reject_discipline',
    'approve_participant',
    'confirm_payment',
    'reject_payment',
    'cancel',
    'create_booking',
    'visitor_approval',
    'view_slip',
    'view_detail',
    'export',
    'print',
    'view_eventlog',
  ],
  Finance: ['confirm_payment', 'reject_payment', 'cancel', 'view_slip', 'view_detail'],
  Vinai: ['approve_discipline', 'reject_discipline', 'view_slip', 'view_detail'],
  Tadtel: ['approve_participant', 'visitor_approval', 'view_slip', 'view_detail'],
  User: ['print'],
};

export const CACHE_TTL = 60;
export const PUBLIC_CACHE_TTL = 300;
export const LOOKUP_CACHE_TTL = 60;
export const LOGIN_RATE_LIMIT_TTL = 300;
export const MAX_LOGIN_ATTEMPTS = 5;
export const CACHE_VERSION = 'v3';
export const PASSWORD_SALT = 'cc-cafe-reservation-v1';

export const VALID_STATUSES = [
  'รอตรวจสอบผู้เข้าร่วม',
  'รอตรวจสอบวินัย',
  'รอชำระเงิน',
  'ชำระแล้ว',
  'เสร็จสิ้น',
  'ไม่อนุมัติ',
  'ยกเลิก',
] as const;

export const ACTIVE_STATUSES = ['รอตรวจสอบผู้เข้าร่วม', 'รอตรวจสอบวินัย', 'รอชำระเงิน', 'ชำระแล้ว', 'เสร็จสิ้น'];

// Named so the table-booking code can reference the two statuses it cares about
// without re-typing Thai string literals that must match VALID_STATUSES exactly.
export const AWAITING_PAYMENT = 'รอชำระเงิน';
export const PAID_STATUS = 'ชำระแล้ว';
export const CANCELLED = 'ยกเลิก';
export const HOLD_EXPIRED_REASON = 'หมดเวลาชำระเงิน';

// ── Table bookings (bookingType = 'table') ────────────────────────
// A parallel, no-prisoner reservation: N tables per day, sold straight into the
// payment step. Overridable per-deployment via admin_settings.tableBooking.
export const BOOKING_TYPE_PRISONER = 'prisoner';
export const BOOKING_TYPE_TABLE = 'table';
export const DEFAULT_TABLES_PER_DAY = 10;
/** How long an unpaid table booking keeps its slot before the hold lapses. */
export const DEFAULT_TABLE_HOLD_MINUTES = 60;
/** People one table seats. The person making the booking occupies one of them,
 *  so a booking may carry at most DEFAULT_TABLE_SEATS - 1 extra visitors. */
export const DEFAULT_TABLE_SEATS = 5;
export const TABLE_BOOKING_SETTING_KEY = 'tableBooking';
/** Distinct ref prefix so staff can tell the two booking kinds apart at a glance. */
export const TABLE_REF_PREFIX = 'TBL-';
export const VISIT_REF_PREFIX = 'VIS-';

export const SAVE_RESERVATION_FIELDS = [
  'ref',
  'timestamp',
  'visitorName',
  'visitorId',
  'visitorPhone',
  'relation',
  'religion',
  'allergy',
  'extraVisitorReligions',
  'extraVisitorAllergies',
  'extraVisitorNames',
  'prisonerName',
  'prisonerId',
  'wing',
  'visitDate',
  'visitDateISO',
  'visitorCount',
  'totalPersons',
  'total',
  'adultCount',
  'child5to8Count',
  'childUnder5Count',
  'visitorAge',
  'status',
  'slipImage',
];

// Accepted on the public table-booking path: SAVE_RESERVATION_FIELDS minus the
// prisoner columns, which have no meaning without a prisoner attached.
export const SAVE_TABLE_RESERVATION_FIELDS = SAVE_RESERVATION_FIELDS.filter(
  (f) => f !== 'prisonerName' && f !== 'prisonerId' && f !== 'wing'
);

export const SAVE_NUMERIC_FIELDS = [
  'visitorCount',
  'totalPersons',
  'total',
  'adultCount',
  'child5to8Count',
  'childUnder5Count',
];

export const SAVE_STRING_CAPS: Record<string, number> = {
  visitorPhone: 32,
  visitorId: 64,
  prisonerId: 64,
  wing: 64,
  ref: 64,
  timestamp: 100,
  visitDate: 200,
  visitDateISO: 10,
  relation: 100,
  religion: 100,
  allergy: 1000,
  extraVisitorReligions: 5000,
  extraVisitorAllergies: 5000,
  extraVisitorNames: 5000,
  visitorName: 200,
  prisonerName: 200,
  visitorAge: 8,
  status: 50,
  slipImage: 2000,
};

export const UPDATE_BOOKING_FIELDS = [
  'visitorName',
  'visitorPhone',
  'visitorId',
  'relation',
  'religion',
  'allergy',
  'prisonerName',
  'prisonerId',
  'wing',
  'visitDate',
  'visitDateISO',
  'visitorCount',
  'totalPersons',
  'total',
  'adultCount',
  'child5to8Count',
  'childUnder5Count',
  'visitorAge',
  'status',
  'extraVisitorNames',
  'extraVisitorReligions',
  'extraVisitorAllergies',
  'extraVisitorApproved',
];

export const UPDATE_BOOKING_NUMERIC = [
  'visitorCount',
  'totalPersons',
  'total',
  'adultCount',
  'child5to8Count',
  'childUnder5Count',
];

export const UPDATE_BOOKING_CAPS: Record<string, number> = {
  visitorName: 200,
  visitorPhone: 32,
  visitorId: 64,
  relation: 100,
  religion: 100,
  allergy: 1000,
  prisonerName: 200,
  prisonerId: 64,
  wing: 64,
  visitDate: 200,
  visitDateISO: 10,
  extraVisitorNames: 5000,
  extraVisitorReligions: 5000,
  extraVisitorAllergies: 5000,
  extraVisitorApproved: 5000,
  visitorAge: 8,
};

export const STANDARD_HEADERS = [
  'ref',
  'timestamp',
  'visitorName',
  'visitorId',
  'visitorPhone',
  'relation',
  'religion',
  'allergy',
  'extraVisitorReligions',
  'extraVisitorAllergies',
  'extraVisitorNames',
  'visitorApproved',
  'extraVisitorApproved',
  'prisonerName',
  'prisonerId',
  'wing',
  'visitDate',
  'visitDateISO',
  'visitorCount',
  'totalPersons',
  'total',
  'adultCount',
  'child5to8Count',
  'childUnder5Count',
  'visitorAge',
  'status',
  'slipImage',
  'cancelReason',
  'bookingType',
];

export const PUBLIC_LOOKUP_FIELDS = [
  'ref',
  'timestamp',
  'status',
  'bookingType',
  'visitDate',
  'visitDateISO',
  'prisonerName',
  'prisonerId',
  'wing',
  'visitorName',
  'visitorApproved',
  'extraVisitorNames',
  'extraVisitorApproved',
  'visitorCount',
  'totalPersons',
  'total',
  'cancelReason',
  'archivedAt',
];

export const DISCIPLINE_STATUS = 'ติดวินัย งดเยี่ยม';
export const DISCIPLINE_GRACE_YEARS = 1;

export const MAX_SLIP_BYTES = 20 * 1024 * 1024;

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

// ── Notifications ─────────────────────────────────────────────────────────
// Event names flow through the `notify` action. Only these names are accepted.
export const NOTIFICATION_EVENTS = [
  'booking_submitted',
  'booking_cancelled',
  'status_changed',
  'payment_due',
  'payment_confirmed',
  'visitor_approved',
  'visitor_rejected',
] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

// Thai copy templates. {placeholders} are filled from the request body.
export const NOTIFY_TEMPLATES: Record<NotificationEvent, { subject: string; body: string }> = {
  booking_submitted: {
    subject: 'แจ้งเตือน: รับการจองแล้ว',
    body: 'การจองเลขที่ {ref} ถูกส่งแล้ว\nผู้ต้องขัง: {prisonerName}\nวันที่เข้าเยี่ยม: {visitDate}\nยอดรวม: {total} บาท\nสถานะ: {status}',
  },
  booking_cancelled: {
    subject: 'แจ้งเตือน: การจองถูกยกเลิก',
    body: 'การจองเลขที่ {ref} ถูกยกเลิก{reason}\nผู้ต้องขัง: {prisonerName}',
  },
  status_changed: {
    subject: 'แจ้งเตือน: สถานะการจองเปลี่ยน',
    body: 'การจองเลขที่ {ref}\nสถานะเปลี่ยนเป็น: {status}\nผู้ต้องขัง: {prisonerName}\nวันที่เข้าเยี่ยม: {visitDate}',
  },
  payment_due: {
    subject: 'แจ้งเตือน: ถึงคิวชำระเงิน',
    body: 'การจองเลขที่ {ref} ได้รับการอนุมัติแล้ว กรุณาชำระเงิน\nผู้ต้องขัง: {prisonerName}\nวันที่เข้าเยี่ยม: {visitDate}\nยอดที่ต้องชำระ: {total} บาท',
  },
  payment_confirmed: {
    subject: 'แจ้งเตือน: ยืนยันการชำระเงิน',
    body: 'การจองเลขที่ {ref} ชำระเงินแล้วเรียบร้อย\nยอดรวม: {total} บาท\nวันที่เข้าเยี่ยม: {visitDate}',
  },
  visitor_approved: {
    subject: 'แจ้งเตือน: อนุมัติผู้เข้าร่วม',
    body: 'การจองเลขที่ {ref} ได้รับการอนุมัติ\nจำนวนผู้เข้าร่วม: {visitorCount} คน\nยอดรวม: {total} บาท',
  },
  visitor_rejected: {
    subject: 'แจ้งเตือน: การจองไม่ผ่านอนุมัติ',
    body: 'การจองเลขที่ {ref} ถูกปฏิเสธ{reason}\nผู้ต้องขัง: {prisonerName}',
  },
};

export const NOTIFICATION_CHANNELS = ['push', 'line'] as const;

export const LINE_MESSAGE_CAP = 200; // monthly push-message quota shared by a LINE OA
export const LINE_CAP_SETTING_KEY = 'line_monthly_cap';
export const NOTIFY_MAX_BODY_BYTES = 1000;
