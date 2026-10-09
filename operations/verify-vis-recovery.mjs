import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { recoverMissingVis, REFS } from './vis-recovery-procedure.mjs';

function fixture(historical) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE reservations (ref TEXT PRIMARY KEY, status TEXT, visitDateISO TEXT, visitorId TEXT, slip_base64 TEXT, slip_key TEXT, cancelAt TEXT, updatedAt TEXT);
    CREATE TABLE reservations_archive (ref TEXT PRIMARY KEY);
    CREATE TABLE reservations_backup (ref TEXT PRIMARY KEY);
    CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT, text TEXT, createdAt TEXT);
    CREATE TABLE event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, username TEXT, action TEXT, targetRef TEXT, details TEXT, result TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE d1_cache (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO settings VALUES ('data_version', '30'), ('data_version:reservations', '25'), ('pricing', 'unchanged');
    INSERT INTO d1_cache VALUES ('reservations', 'stale'), ('rl:visitor', '2');`);
  db.prepare('INSERT INTO reservations VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('VIS-OTHER', 'เสร็จสิ้น', historical ? '2026-10-01' : '2026-10-20', historical ? 'old' : 'latest', '', '', '', 'latest-time');
  db.prepare('INSERT INTO notes (ref, text, createdAt) VALUES (?, ?, ?)').run('VIS-OTHER', 'Latest unrelated note', 'today');
  if (historical) {
    for (const ref of REFS) db.prepare('INSERT INTO reservations VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(ref, 'ยกเลิก', '2026-10-05', 'ORIGINAL-ID', 'ORIGINAL-SLIP', `${ref}.png`, '2026-10-02', '2026-10-02');
    db.prepare('INSERT INTO notes (ref, text, createdAt) VALUES (?, ?, ?)').run(REFS[0], 'Original cancellation note', '2026-10-02');
  }
  if (!historical) db.exec("ALTER TABLE reservations ADD COLUMN extraPrisoners TEXT NOT NULL DEFAULT ''");
  return db;
}

for (const scenario of ['success', 'historical_read_failure', 'insert_failure', 'wrong_historical_status', 'lost_restore_response', 'current_restore_failure']) {
  let latest = fixture(false);
  const historical = fixture(true);
  if (scenario === 'wrong_historical_status') historical.prepare('UPDATE reservations SET status = ? WHERE ref = ?').run('เสร็จสิ้น', REFS[0]);
  let active = latest;
  let inserts = 0;
  let responseLost = false;
  const states = [];
  const api = async (path, body) => {
    if (path === 'time_travel/bookmark') return { bookmark: 'LATEST' };
    if (path === 'time_travel/restore') {
      if (scenario === 'current_restore_failure' && body.bookmark === 'LATEST') throw new Error('Latest restore failed');
      if (body.bookmark === 'LATEST') { latest.close(); latest = fixture(false); }
      active = body.bookmark === 'LATEST' ? latest : historical;
      if (scenario === 'lost_restore_response' && !body.bookmark && !responseLost) { responseLost = true; throw new Error('Network response lost'); }
      return {};
    }
    if (scenario === 'historical_read_failure' && active === historical && body.sql.includes('WHERE ref IN')) throw new Error('Historical read failed');
    if (scenario === 'insert_failure' && active === latest && body.sql.startsWith('INSERT INTO reservations') && ++inserts === 2) throw new Error('Second insert failed');
    const statement = active.prepare(body.sql);
    const results = statement.columns().length ? statement.all(...body.params) : (statement.run(...body.params), []);
    return [{ success: true, results }];
  };
  if (scenario === 'success') {
    const result = await recoverMissingVis({ api, checkpoint: async state => states.push(state) });
    assert.equal(result.length, 3);
    assert.ok(result.every(row => row.status === 'ยกเลิก' && row.visitDateISO === '2026-10-05' && row.hasSlip));
    assert.equal(latest.prepare('SELECT visitorId FROM reservations WHERE ref = ?').get(REFS[0]).visitorId, 'ORIGINAL-ID');
    assert.equal(latest.prepare('SELECT extraPrisoners FROM reservations WHERE ref = ?').get(REFS[0]).extraPrisoners, '', 'New columns keep current schema defaults');
    assert.equal(latest.prepare('SELECT text FROM notes WHERE ref = ?').get(REFS[0]).text, 'Original cancellation note');
    assert.equal(latest.prepare('SELECT COUNT(*) n FROM event_log WHERE action = ?').get('booking_recovered').n, 3);
    assert.equal(states.at(-1).phase, 'complete');
  } else if (scenario === 'current_restore_failure') {
    await assert.rejects(recoverMissingVis({ api, checkpoint: async state => states.push(state) }));
    assert.equal(states.at(-1).safeToResume, false, 'Stay in maintenance until current data is restored');
    assert.equal(active, historical);
  } else {
    await assert.rejects(recoverMissingVis({ api, checkpoint: async state => states.push(state) }));
    assert.equal(active, latest, 'Current database restored even on failure');
    assert.equal(latest.prepare('SELECT COUNT(*) n FROM reservations').get().n, 1, 'No partial recovered rows');
  }
  if (scenario !== 'current_restore_failure') assert.equal(active, latest);
  assert.equal(latest.prepare('SELECT visitorId FROM reservations WHERE ref = ?').get('VIS-OTHER').visitorId, 'latest', 'Newer unrelated booking preserved');
  assert.equal(latest.prepare('SELECT text FROM notes WHERE ref = ?').get('VIS-OTHER').text, 'Latest unrelated note');
  console.log(`${scenario}: passed`);
}
