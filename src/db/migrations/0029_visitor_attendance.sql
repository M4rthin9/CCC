-- Attendance is independent of reservation status, pricing, and daily reports.
CREATE TABLE visitor_attendance (
  ref TEXT NOT NULL,
  visitDateISO TEXT NOT NULL,
  guestKey TEXT NOT NULL,
  guestName TEXT NOT NULL,
  checkedInAt TEXT NOT NULL,
  checkedInBy TEXT NOT NULL,
  PRIMARY KEY (ref, visitDateISO, guestKey)
);
CREATE INDEX idx_visitor_attendance_date ON visitor_attendance(visitDateISO, checkedInAt);
