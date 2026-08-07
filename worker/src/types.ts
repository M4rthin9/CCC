export interface Env {
  DB: D1Database;
  CC_CACHE: KVNamespace;
  CC_SLIPS: R2Bucket;
  REALTIME_HUB: DurableObjectNamespace;
  ASSETS?: Fetcher;
  TURNSTILE_SECRET?: string;
  TURNSTILE_HOSTNAMES?: string;
  SEED_USERS_JSON?: string;
  DISABLE_SEED_USERS?: string;
  PASSWORD_SALT?: string;
  GAS_BACKEND_URL?: string;
  ADMIN_EXPORT_TOKEN?: string;
  ENVIRONMENT?: string;
  ARCHIVE_MONTHS?: string;
  BACKUP_RETENTION_DAYS?: string;
}

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  salt: string;
  algo: string;
  role: string;
  display_name: string;
  must_change_password: number;
  created_at: string;
}

export interface SessionRow {
  token_hash: string;
  user_id: number;
  created_at: string;
  expires_at: string;
  ip: string | null;
  user_agent: string | null;
}

export interface BookingRow {
  id: number;
  ref: string;
  timestamp: string;
  visitor_name: string | null;
  visitor_id: string | null;
  visitor_phone: string | null;
  relation: string | null;
  religion: string | null;
  allergy: string | null;
  extra_visitor_religions: string | null;
  extra_visitor_allergies: string | null;
  extra_visitor_names: string | null;
  visitor_approved: string | null;
  extra_visitor_approved: string | null;
  prisoner_id: string;
  prisoner_name: string | null;
  wing: string | null;
  visit_date: string | null;
  visit_date_iso: string;
  visitor_count: number;
  total_persons: number;
  total: number;
  adult_count: number;
  child5to8_count: number;
  child_under5_count: number;
  status: string;
  slip_key: string | null;
  cancel_reason: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PrisonerRow {
  id: number;
  prisoner_id: string;
  prisoner_name: string;
  wing: string | null;
  status: string | null;
  vinai_date: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface NoteRow {
  id: number;
  ref: string;
  text: string;
  user: string | null;
  timestamp: string | null;
  created_at: string;
}

export interface EventLogRow {
  id: number;
  timestamp: string;
  username: string | null;
  action: string | null;
  target_ref: string | null;
  details_json: string | null;
  result: string | null;
  ip: string | null;
  user_agent: string | null;
}

export interface RealTimeEvent {
  type: string;
  ref?: string;
  at: string;
}
