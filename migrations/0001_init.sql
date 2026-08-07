-- 0001_init.sql — CCC Cafe Reservation (Cloudflare Backend)
-- Single database for all data. Rows stay in bookings until archived.
PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL DEFAULT '',
  algo TEXT NOT NULL DEFAULT 'pbkdf2',
  role TEXT NOT NULL,
  display_name TEXT DEFAULT '',
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  permissions_json TEXT NOT NULL
);

CREATE TABLE bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL UNIQUE,
  timestamp TEXT NOT NULL,
  visitor_name TEXT,
  visitor_id TEXT,
  visitor_phone TEXT,
  relation TEXT,
  religion TEXT,
  allergy TEXT,
  extra_visitor_religions TEXT,
  extra_visitor_allergies TEXT,
  extra_visitor_names TEXT,
  visitor_approved TEXT,
  extra_visitor_approved TEXT,
  prisoner_id TEXT NOT NULL,
  prisoner_name TEXT,
  wing TEXT,
  visit_date TEXT,
  visit_date_iso TEXT NOT NULL,
  visitor_count INTEGER DEFAULT 0,
  total_persons INTEGER DEFAULT 0,
  total INTEGER DEFAULT 0,
  adult_count INTEGER DEFAULT 0,
  child5to8_count INTEGER DEFAULT 0,
  child_under5_count INTEGER DEFAULT 0,
  status TEXT NOT NULL,
  slip_key TEXT,
  cancel_reason TEXT,
  archived_at TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Backstop for the app-level duplicate guard: one active booking per prisoner per visit date.
CREATE UNIQUE INDEX idx_booking_active_dup
  ON bookings(prisoner_id, visit_date_iso)
  WHERE status IN ('รอตรวจสอบผู้เข้าร่วม', 'รอตรวจสอบวินัย', 'รอชำระเงิน', 'ชำระแล้ว', 'เสร็จสิ้น');
CREATE INDEX idx_booking_date ON bookings(status, visit_date_iso);
CREATE INDEX idx_booking_archived ON bookings(archived_at);
CREATE INDEX idx_booking_prisoner ON bookings(prisoner_id);
CREATE INDEX idx_booking_ref ON bookings(ref);

CREATE TABLE prisoners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prisoner_id TEXT NOT NULL UNIQUE COLLATE NOCASE,
  prisoner_name TEXT NOT NULL,
  wing TEXT,
  status TEXT,
  vinai_date TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_prisoners_name ON prisoners(prisoner_name);

CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL,
  text TEXT NOT NULL,
  user TEXT,
  timestamp TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_notes_ref ON notes(ref);

CREATE TABLE event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  username TEXT,
  action TEXT,
  target_ref TEXT,
  details_json TEXT,
  result TEXT,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX idx_eventlog_ts ON event_log(timestamp);
CREATE INDEX idx_eventlog_action ON event_log(action);
CREATE INDEX idx_eventlog_username ON event_log(username);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  saved_by TEXT,
  saved_at TEXT
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX idx_sessions_exp ON sessions(expires_at);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO meta (key, value, updated_at) VALUES ('version', '0', '');

-- Built-in roles (parity with the GAS PERMISSIONS map; also ensured at runtime).
INSERT OR IGNORE INTO roles (role_name, permissions_json) VALUES
  ('Superadmin', '["approve","reject","approve_discipline","reject_discipline","approve_participant","confirm_payment","reject_payment","cancel","visitor_approval","view_slip","view_detail","export","print","manage_users","manage_settings","view_eventlog"]'),
  ('Admin', '["approve","reject","approve_discipline","reject_discipline","approve_participant","confirm_payment","reject_payment","cancel","visitor_approval","view_slip","view_detail","export","print","view_eventlog"]'),
  ('Finance', '["confirm_payment","reject_payment","cancel","view_slip","view_detail"]'),
  ('Vinai', '["approve_discipline","reject_discipline","view_slip","view_detail"]'),
  ('Tadtel', '["approve_participant","visitor_approval","view_slip","view_detail"]'),
  ('User', '["print"]');
