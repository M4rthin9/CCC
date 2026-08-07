export const AVAILABLE_PERMISSIONS = [
  'approve',
  'reject',
  'approve_discipline',
  'reject_discipline',
  'approve_participant',
  'cancel',
  'confirm_payment',
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

export const PERMISSIONS: Record<string, readonly string[]> = {
  Superadmin: [
    'approve',
    'reject',
    'approve_discipline',
    'reject_discipline',
    'approve_participant',
    'confirm_payment',
    'reject_payment',
    'cancel',
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

export function isActiveReservationStatus(status: unknown): boolean {
  return ACTIVE_STATUSES.includes(String(status || '').trim());
}

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
  'status',
  'slipImage',
];

export const SAVE_NUMERIC_FIELDS = ['visitorCount', 'totalPersons', 'total', 'adultCount', 'child5to8Count', 'childUnder5Count'];

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
  'total',
  'status',
  'extraVisitorNames',
  'extraVisitorReligions',
  'extraVisitorAllergies',
  'extraVisitorApproved',
];

export const UPDATE_BOOKING_NUMERIC = ['visitorCount', 'total'];

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
  'status',
  'slipImage',
  'cancelReason',
];

export const PUBLIC_LOOKUP_FIELDS = [
  'ref',
  'timestamp',
  'status',
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

export const CACHE_TTL = 60;
export const PUBLIC_CACHE_TTL = 300;
export const LOOKUP_CACHE_TTL = 15;
export const LOGIN_RATE_LIMIT_TTL = 300;
export const MAX_LOGIN_ATTEMPTS = 5;
export const BOOKING_RATE_LIMIT_MAX = 10;
export const BOOKING_RATE_LIMIT_TTL = 300;
export const CACHE_VERSION = 'v3';
export const PASSWORD_SALT_DEFAULT = 'cc-cafe-reservation-v1';
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'cc_session';
export const ARCHIVE_MONTHS = 3;
export const BACKUP_RETENTION_DAYS = 30;
export const MAX_SLIP_BYTES = 20 * 1024 * 1024;
export const REALTIME_MAX_CONN_PER_IP = 5;
