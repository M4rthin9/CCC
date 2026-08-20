export interface Env {
  DB: D1Database;
  CACHE_KV: KVNamespace;
  JWT_SECRET: string;
  JWT_REFRESH_SECRET: string;
  TURNSTILE_SECRET: string;
  TURNSTILE_ALLOWED_HOSTNAMES: string;
  CACHE_VERSION: string;
  PASSWORD_SALT: string;
  ALLOWED_ORIGINS: string;
  // Notifications (Web Push + LINE). VAPID keys and LINE credentials are secrets.
  LINE_OA_ID?: string;
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  LINE_CHANNEL_SECRET?: string;
  LINE_MONTHLY_CAP?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  NOTIFY_PUSH_ENABLED?: string;
  NOTIFY_LINE_ENABLED?: string;
  /** Comma-separated notification events allowed to spend quota. */
  NOTIFY_EVENT_ALLOWLIST?: string;
  /** "true" = only LINE-push a booking that has no browser subscription. */
  NOTIFY_LINE_FALLBACK_ONLY?: string;
  // Slip auto-verification (Workers AI OCR).
  AI?: Ai;
  SLIP_OCR_ENABLED?: string;
  SLIP_OCR_MODEL?: string;
  SLIP_OCR_DAILY_MAX?: string;
  SLIP_AUTO_APPROVE_ENABLED?: string;
  SLIP_MAX_AGE_HOURS?: string;
}

export interface User {
  username: string;
  password: string;
  role: string;
  displayName: string;
  createdAt: string;
  passwordMigrated?: string | number | boolean;
}

export interface PublicUser {
  username: string;
  role: string;
  displayName: string;
  createdAt: string;
}

export interface Prisoner {
  prisonerId: string;
  prisonerName: string;
  wing: string;
  status: string;
  vinaiDate: string;
  note: string;
}

export interface Reservation {
  [key: string]: unknown;
  ref: string;
  timestamp?: string;
  visitorName?: string;
  visitorId?: string;
  visitorPhone?: string;
  relation?: string;
  religion?: string;
  allergy?: string;
  extraVisitorReligions?: string;
  extraVisitorAllergies?: string;
  extraVisitorNames?: string;
  visitorApproved?: string;
  extraVisitorApproved?: string;
  prisonerName?: string;
  prisonerId?: string;
  wing?: string;
  visitDate?: string;
  visitDateISO?: string;
  visitorCount?: number;
  totalPersons?: number;
  total?: number;
  adultCount?: number;
  child5to8Count?: number;
  childUnder5Count?: number;
  visitorAge?: string;
  payment_ref1?: string;
  slip_ocr_json?: string;
  slip_decision?: string;
  slip_decision_json?: string;
  status?: string;
  slipImage?: string;
  cancelReason?: string;
  createdAt?: string;
  updatedAt?: string;
  version?: number;
  createdBy?: string;
  source?: string;
  _archived?: boolean;
}

export interface RolePermission {
  roleName: string;
  permissions: string[];
}

export interface EventLog {
  timestamp: string;
  username: string;
  action: string;
  targetRef: string;
  details: string;
  result: string;
  ip: string;
  userAgent: string;
}

export interface Note {
  ref: string;
  text: string;
  user: string;
  timestamp: string;
  createdAt: string;
}

export interface AuthUser {
  username: string;
  role: string;
  displayName: string;
}

export interface ApiResult {
  status: string;
  [key: string]: unknown;
}

export type HandlerContext = {
  env: Env;
  request: Request;
  ip: string;
  userAgent: string;
};
