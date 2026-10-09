import { createHash } from 'node:crypto';

export const REFS = ['VIS-90290', 'VIS-73239', 'VIS-21775'];
export const RECOVERY_TIMESTAMP = '2026-10-07T16:59:00Z';
const identifier = name => {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error('Unexpected SQL identifier');
  return `"${name}"`;
};
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// The caller must first pause fetch, scheduled and queue writes, wait for
// in-flight requests to finish, and explicitly obtain maintenance approval.
// No credentials or customer data may be printed by the API/checkpoint adapters.
export async function recoverMissingVis({ api, checkpoint }) {
  const query = async (sql, params = []) => {
    const result = await api('query', { sql, params });
    if (!Array.isArray(result) || result.some(r => !r.success)) throw new Error('D1 query failed');
    return result[0].results;
  };
  const rowsForRefs = table => query(`SELECT * FROM ${identifier(table)} WHERE ref IN (?, ?, ?) ORDER BY ref`, REFS);
  const snapshot = async () => {
    const tables = await query("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name");
    const data = {};
    for (const table of tables) {
      const rows = [];
      for (let offset = 0; ; offset += 50) {
        const page = await query(`SELECT * FROM ${identifier(table.name)} ORDER BY rowid LIMIT 50 OFFSET ?`, [offset]);
        rows.push(...page);
        if (page.length < 50) break;
      }
      data[table.name] = { schema: table.sql, rows };
    }
    return data;
  };
  const compare = (before, after, recovered = false) => {
    if (Object.keys(before).join(',') !== Object.keys(after).join(',')) throw new Error('Database tables changed');
    for (const name of Object.keys(before)) {
      if (before[name].schema !== after[name].schema) throw new Error(`Database schema changed: ${name}`);
      const keep = row => !(recovered && (
        ((name === 'reservations' || name === 'notes') && REFS.includes(row.ref)) ||
        (name === 'event_log' && REFS.includes(row.targetRef)) ||
        (name === 'settings' && ['data_version', 'data_version:reservations'].includes(row.key)) ||
        (name === 'd1_cache' && /:(allReservations|counts|tableCounts|allArchived)$|:(monthlyReport|filteredReport|lookup):/.test(row.key))
      ));
      if (hash(before[name].rows.filter(keep)) !== hash(after[name].rows.filter(keep))) {
        throw new Error(`Unrelated records changed: ${name}`);
      }
    }
  };
  const initial = await snapshot();
  for (const name of ['reservations', 'reservations_archive', 'reservations_backup']) {
    if (initial[name]?.rows.some(row => REFS.includes(row.ref))) throw new Error('A target reference already exists; refusing to overwrite');
  }
  const latest = await api('time_travel/bookmark');
  if (!latest.bookmark) throw new Error('Current recovery bookmark was not returned');
  await checkpoint({ phase: 'ready', safeToResume: true, latestBookmark: latest.bookmark, initial });

  let originalRows;
  let originalNotes = [];
  let attemptedHistoricalRestore = false;
  let returnedToLatest = false;
  const restoreLatest = async () => {
    let error;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await api('time_travel/restore', { bookmark: latest.bookmark });
        compare(initial, await snapshot());
        returnedToLatest = true;
        return;
      } catch (failure) { error = failure; }
    }
    throw error;
  };

  try {
    await checkpoint({ phase: 'reading_history', safeToResume: false, latestBookmark: latest.bookmark });
    attemptedHistoricalRestore = true;
    await api('time_travel/restore', { timestamp: RECOVERY_TIMESTAMP });
    originalRows = await rowsForRefs('reservations');
    if (originalRows.length !== REFS.length || originalRows.some(row => row.status !== 'ยกเลิก' || row.visitDateISO !== '2026-10-05')) {
      throw new Error('Historical snapshot does not contain all three original cancelled October 5 bookings');
    }
    if (initial.notes) originalNotes = await rowsForRefs('notes');
    await checkpoint({ phase: 'originals_saved', safeToResume: false, latestBookmark: latest.bookmark, originalRows, originalNotes });
  } finally {
    // Attempt even when the first restore's HTTP response failed: it may have
    // changed D1 before the connection failed. Never leave the old database live.
    if (attemptedHistoricalRestore) await restoreLatest();
    if (returnedToLatest) await checkpoint({ phase: 'latest_restored', safeToResume: true, latestBookmark: latest.bookmark });
  }

  try {
    await checkpoint({ phase: 'restoring_records', safeToResume: false, latestBookmark: latest.bookmark });
    const schema = await query('PRAGMA table_info(reservations)');
    for (const row of originalRows) {
      const columns = schema.map(column => column.name).filter(column => Object.hasOwn(row, column));
      await query(`INSERT INTO reservations (${columns.map(identifier).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, columns.map(column => row[column]));
    }
    // Keep original note content and times. Omit the old auto-increment ID so
    // a newer note that reused it cannot be overwritten. Do not re-enable old
    // notification subscriptions or pending messages.
    if (originalNotes.length) {
      const schema = await query('PRAGMA table_info(notes)');
      for (const note of originalNotes) {
        const columns = schema.map(column => column.name).filter(column => column !== 'id' && Object.hasOwn(note, column));
        await query(`INSERT INTO notes (${columns.map(identifier).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, columns.map(column => note[column]));
      }
    }
    await query("DELETE FROM d1_cache WHERE key LIKE '%:allReservations' OR key LIKE '%:counts' OR key LIKE '%:tableCounts' OR key LIKE '%:allArchived' OR key LIKE '%:monthlyReport:%' OR key LIKE '%:filteredReport:%' OR key LIKE '%:lookup:%'");
    await query("UPDATE settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key IN ('data_version', 'data_version:reservations')");
    for (const row of originalRows) {
      await query("INSERT INTO event_log (timestamp, username, action, targetRef, details, result) VALUES (strftime('%Y-%m-%d %H:%M:%S', 'now', '+7 hours'), 'system', 'booking_recovered', ?, ?, 'success')", [row.ref, JSON.stringify({ originalStatus: row.status, visitDateISO: row.visitDateISO, recoveredFrom: RECOVERY_TIMESTAMP })]);
    }
    const restored = await rowsForRefs('reservations');
    for (const original of originalRows) {
      const actual = restored.find(row => row.ref === original.ref);
      if (!actual || Object.keys(original).some(column => original[column] !== actual[column])) throw new Error('A recovered original field differs');
    }
    compare(initial, await snapshot(), true);
    await checkpoint({ phase: 'complete', safeToResume: true, latestBookmark: latest.bookmark, recovered: REFS });
    return restored.map(row => ({ ref: row.ref, status: row.status, visitDateISO: row.visitDateISO, hasSlip: !!(row.slipImage || row.slip_base64 || row.slip_key) }));
  } catch (error) {
    // Partial inserts are also reversible while all writers remain paused.
    await restoreLatest();
    await checkpoint({ phase: 'recovery_failed_current_data_restored', safeToResume: true, latestBookmark: latest.bookmark });
    throw error;
  }
}
