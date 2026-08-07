-- Migration 0001: initial schema for the Prison Visitor Reservation System
-- Mirrors the Google Sheets structure from the legacy Apps Script backend.

-- Users (was the "Users" sheet)
CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  password TEXT NOT NULL,
  role TEXT NOT NULL,
  displayName TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  passwordMigrated TEXT NOT NULL DEFAULT 'FALSE'
);

-- Dynamic roles (was the "Roles" sheet — roleName + one boolean column per permission)
CREATE TABLE IF NOT EXISTS roles (
  roleName TEXT PRIMARY KEY,
  approve INTEGER NOT NULL DEFAULT 0,
  reject INTEGER NOT NULL DEFAULT 0,
  confirm_payment INTEGER NOT NULL DEFAULT 0,
  reject_payment INTEGER NOT NULL DEFAULT 0,
  cancel INTEGER NOT NULL DEFAULT 0,
  visitor_approval INTEGER NOT NULL DEFAULT 0,
  view_slip INTEGER NOT NULL DEFAULT 0,
  view_detail INTEGER NOT NULL DEFAULT 0,
  export INTEGER NOT NULL DEFAULT 0,
  print INTEGER NOT NULL DEFAULT 0,
  manage_users INTEGER NOT NULL DEFAULT 0,
  view_eventlog INTEGER NOT NULL DEFAULT 0,
  approve_discipline INTEGER NOT NULL DEFAULT 0,
  reject_discipline INTEGER NOT NULL DEFAULT 0,
  approve_participant INTEGER NOT NULL DEFAULT 0,
  manage_settings INTEGER NOT NULL DEFAULT 0
);

-- Prisoners (was the "ผู้ต้องขัง" sheet)
CREATE TABLE IF NOT EXISTS prisoners (
  prisonerId TEXT PRIMARY KEY,
  prisonerName TEXT NOT NULL,
  wing TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  vinaiDate TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT ''
);

-- Reservations (was the "การจอง" sheet). slipImage holds a Drive thumbnail URL
-- for legacy rows; new uploads store a base64 data URI in slip_base64.
CREATE TABLE IF NOT EXISTS reservations (
  ref TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL DEFAULT '',
  visitorName TEXT NOT NULL DEFAULT '',
  visitorId TEXT NOT NULL DEFAULT '',
  visitorPhone TEXT NOT NULL DEFAULT '',
  relation TEXT NOT NULL DEFAULT '',
  religion TEXT NOT NULL DEFAULT '',
  allergy TEXT NOT NULL DEFAULT '',
  extraVisitorReligions TEXT NOT NULL DEFAULT '',
  extraVisitorAllergies TEXT NOT NULL DEFAULT '',
  extraVisitorNames TEXT NOT NULL DEFAULT '',
  visitorApproved TEXT NOT NULL DEFAULT '',
  extraVisitorApproved TEXT NOT NULL DEFAULT '',
  prisonerName TEXT NOT NULL DEFAULT '',
  prisonerId TEXT NOT NULL DEFAULT '',
  wing TEXT NOT NULL DEFAULT '',
  visitDate TEXT NOT NULL DEFAULT '',
  visitDateISO TEXT NOT NULL DEFAULT '',
  visitorCount INTEGER NOT NULL DEFAULT 0,
  totalPersons INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  adultCount INTEGER NOT NULL DEFAULT 0,
  child5to8Count INTEGER NOT NULL DEFAULT 0,
  childUnder5Count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'รอตรวจสอบผู้เข้าร่วม',
  slipImage TEXT NOT NULL DEFAULT '',
  slip_base64 TEXT NOT NULL DEFAULT '',
  cancelReason TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL DEFAULT '',
  updatedAt TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  createdBy TEXT NOT NULL DEFAULT 'legacy'
);

-- Archived reservations (was the "การจอง_Archive" sheet)
CREATE TABLE IF NOT EXISTS reservations_archive (
  ref TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL DEFAULT '',
  visitorName TEXT NOT NULL DEFAULT '',
  visitorId TEXT NOT NULL DEFAULT '',
  visitorPhone TEXT NOT NULL DEFAULT '',
  relation TEXT NOT NULL DEFAULT '',
  religion TEXT NOT NULL DEFAULT '',
  allergy TEXT NOT NULL DEFAULT '',
  extraVisitorReligions TEXT NOT NULL DEFAULT '',
  extraVisitorAllergies TEXT NOT NULL DEFAULT '',
  extraVisitorNames TEXT NOT NULL DEFAULT '',
  visitorApproved TEXT NOT NULL DEFAULT '',
  extraVisitorApproved TEXT NOT NULL DEFAULT '',
  prisonerName TEXT NOT NULL DEFAULT '',
  prisonerId TEXT NOT NULL DEFAULT '',
  wing TEXT NOT NULL DEFAULT '',
  visitDate TEXT NOT NULL DEFAULT '',
  visitDateISO TEXT NOT NULL DEFAULT '',
  visitorCount INTEGER NOT NULL DEFAULT 0,
  totalPersons INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  adultCount INTEGER NOT NULL DEFAULT 0,
  child5to8Count INTEGER NOT NULL DEFAULT 0,
  childUnder5Count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'รอตรวจสอบผู้เข้าร่วม',
  slipImage TEXT NOT NULL DEFAULT '',
  slip_base64 TEXT NOT NULL DEFAULT '',
  cancelReason TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL DEFAULT '',
  updatedAt TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  createdBy TEXT NOT NULL DEFAULT 'legacy',
  archivedAt TEXT NOT NULL DEFAULT ''
);

-- Event log (was the "EventLog" sheet)
CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  username TEXT NOT NULL DEFAULT 'system',
  action TEXT NOT NULL DEFAULT '',
  targetRef TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT 'success',
  ip TEXT NOT NULL DEFAULT '',
  userAgent TEXT NOT NULL DEFAULT ''
);

-- Notes (was the "Notes" sheet)
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL,
  text TEXT NOT NULL,
  user TEXT NOT NULL DEFAULT '',
  timestamp TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL DEFAULT ''
);

-- Settings (was stored in Apps Script Script Properties as a single JSON blob)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  savedBy TEXT NOT NULL DEFAULT '',
  savedAt TEXT NOT NULL DEFAULT ''
);

-- Refresh tokens for JWT session refresh (new in the Workers backend)
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  tokenHash TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);

-- Data version counter (replaces PropertiesService DATA_VERSION bumping)
CREATE TABLE IF NOT EXISTS data_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO data_version (id, version) VALUES (1, 0);
