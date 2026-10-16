import {readFileSync,writeFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {api,dbPath,query,loadPlan,savePlan,assert,sleep,exportSql,sqlite,tableProof,encrypt} from './prisoner-recovery-lib.mjs';
import {columns,normalize,insertStatement,insertBatches} from './prisoner-recovery-core.mjs';
const plan=loadPlan();
assert(plan.frozen && plan.maintenanceActive && !plan.complete,'Recovery requires frozen backup and maintenance');
const baseline=JSON.parse(readFileSync('frozen-proof.json','utf8'));
const frozen=sqlite(readFileSync('frozen-database.sql','utf8'));
const existing=frozen.prepare('SELECT '+columns.join(',')+' FROM prisoners ORDER BY prisonerId').all();
const beforeIds=new Set(existing.map(p=>p.prisonerId));
let recovered;
async function returnToCurrent() {
  for(let attempt=0;attempt<6;attempt++) {
    try {
      await api(`${dbPath}/time_travel/restore?bookmark=${encodeURIComponent(plan.currentBookmark)}`,{},'POST');
      plan.historical=false;
      savePlan(plan);
      const proof=tableProof(sqlite(await exportSql()));
      assert(isDeepStrictEqual(proof,baseline),'Current database did not match the frozen backup');
      plan.safeToReopen=true;
      savePlan(plan);
      console.log('CURRENT DATABASE RESTORED; every table matches frozen backup');
      return;
    } catch {
      if(attempt===5) throw new Error('Unable to verify return to current database; keep maintenance active');
      await sleep(2000*(attempt+1));
    }
  }
}
plan.historical=true;
plan.safeToReopen=false;
savePlan(plan);
try {
  const restored=await api(`${dbPath}/time_travel/restore?bookmark=${encodeURIComponent(plan.beforeBookmark)}`,{},'POST');
  assert(restored.previous_bookmark,'Historical restore did not return undo bookmark');
  plan.currentBookmark=restored.previous_bookmark;
  savePlan(plan);
  recovered=await query('SELECT '+columns.join(',')+' FROM prisoners ORDER BY prisonerId');
  assert(recovered.length===6319,'Historical prisoner count does not match pre-incident count');
  assert(recovered.every(p=>p.prisonerId && columns.every(c=>typeof p[c]==='string')),'Historical prisoner fields are invalid');
  assert((await query("SELECT count(*) AS count FROM event_log WHERE action='import_prisoners' AND timestamp='2026-10-15 15:23:16'"))[0].count===0,'Historical state still contains accidental import');
  assert(existing.every(p=>recovered.some(r=>r.prisonerId===p.prisonerId)),'Remaining prisoner did not exist in recovered list');
  encrypt('recovered-prisoners',JSON.stringify(recovered));
  console.log('PRE-INCIDENT LIST RETRIEVED: 6319 prisoners');
} finally {
  await returnToCurrent();
}
const missing=recovered.filter(p=>!beforeIds.has(p.prisonerId));
assert(missing.length===6318,'Expected exactly 6318 missing prisoners');
let inserted=0;
for(const batch of insertBatches(missing)) {
  await query(insertStatement(batch));
  inserted+=batch.length;
  if(inserted%1000===0 || inserted===missing.length) console.log('RESTORED MISSING PRISONERS',inserted);
}
const actual=await query('SELECT '+columns.join(',')+' FROM prisoners ORDER BY prisonerId');
assert(actual.length===6319,'Final prisoner count differs from expected');
const actualById=new Map(actual.map(row=>[row.prisonerId,row]));
assert(missing.every(row=>isDeepStrictEqual(normalize(actualById.get(row.prisonerId)),normalize(row))),'Restored prisoner fields differ from source');
assert(existing.every(row=>isDeepStrictEqual(normalize(actualById.get(row.prisonerId)),normalize(row))),'Remaining prisoner was modified');
const proof=tableProof(sqlite(await exportSql()));
for(const table of Object.keys(baseline).filter(name=>name!=='prisoners')) {
  assert(isDeepStrictEqual(baseline[table],proof[table]),`Unexpected change to table ${table}`);
}
console.log('ALL OTHER TABLES VERIFIED UNCHANGED',Object.keys(baseline).length-1);
await query("DELETE FROM d1_cache WHERE key='prisoners'");
for(const key of ['data_version:prisoners','data_version']) {
  await query("INSERT INTO settings(key,value,savedBy,savedAt) VALUES(?,CAST(unixepoch() AS TEXT),'system',strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT),savedAt=excluded.savedAt",[key]);
}
const details={restored:missing.length,total:actual.length,preservedExisting:existing.length,sourceTimestamp:'2026-10-15T08:22:00Z',incidentTimestamp:'2026-10-15 15:23:16',otherTablesVerifiedUnchanged:true};
await query("INSERT INTO event_log(timestamp,username,action,targetRef,details,result,ip,userAgent) VALUES(datetime('now','+7 hours'),'system','restore_prisoners','',?,'success','','Codex database recovery')",[JSON.stringify(details)]);
plan.complete=true;
savePlan(plan);
const report={...details,before:baseline,afterPrisonerRestore:proof,completedAt:new Date().toISOString()};
writeFileSync('recovery-artifacts/restoration-report.json',JSON.stringify(report,null,2));
console.log('RECOVERY VERIFIED',JSON.stringify(details));
