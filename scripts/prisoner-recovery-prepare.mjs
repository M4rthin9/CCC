import {writeFileSync} from 'node:fs';
import {api, worker, dbPath, query, exportSql, sqlite, tableProof, encrypt, savePlan, assert} from './prisoner-recovery-lib.mjs';
const deployments = await api(`${worker}/deployments`);
const active = deployments.deployments[0];
assert(active.versions.length === 1 && active.versions[0].percentage === 100, 'Expected one active production version');
const version = await api(`${worker}/versions/${active.versions[0].version_id}`);
const settings = await api(`${worker}/settings`);
const before = await api(`${dbPath}/time_travel/bookmark?timestamp=2026-10-15T08%3A22%3A00Z`);
const incident = await query("SELECT timestamp, username, details FROM event_log WHERE action='import_prisoners' AND timestamp='2026-10-15 15:23:16'");
assert(incident.length === 1 && JSON.parse(incident[0].details).removed === 6318, 'Incident does not match');
assert((await query('SELECT count(*) AS count FROM prisoners'))[0].count === 1, 'Production prisoner count changed; re-investigate');
const sql = await exportSql();
const db = sqlite(sql);
const proof = tableProof(db);
encrypt('preflight-database',sql);
writeFileSync('recovery-artifacts/preflight-proof.json',JSON.stringify(proof,null,2));
const maintenance = `export default {
 fetch() { return new Response(JSON.stringify({status:'maintenance',message:'Restoring prisoner records. Please try again shortly.'}), {status:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Retry-After':'120','X-Prisoner-Recovery':'20261016'}}); },
 scheduled() {},
 queue(batch) {batch.retryAll({delaySeconds:120});}
};`;
const metadata = {
  main_module:'recovery-maintenance.mjs',
  compatibility_date:settings.compatibility_date,
  compatibility_flags:settings.compatibility_flags,
  bindings:(version.resources.bindings ?? settings.bindings ?? []).map(b => ({name:b.name,type:'inherit'})),
  annotations:{'workers/message':'Temporary maintenance for prisoner recovery','workers/tag':'prisoner-recovery-20261016'},
};
const form = new FormData();
form.set('metadata',new Blob([JSON.stringify(metadata)],{type:'application/json'}));
form.set('recovery-maintenance.mjs',new Blob([maintenance],{type:'application/javascript+module'}),'recovery-maintenance.mjs');
const uploaded = await api(`${worker}/versions?bindings_inherit=strict`,form);
const plan = {originalVersions:active.versions,maintenanceVersion:uploaded.id,beforeBookmark:before.bookmark,maintenanceActive:false,historical:false,complete:false};
savePlan(plan);
writeFileSync('recovery-artifacts/recovery-plan.json',JSON.stringify(plan,null,2));
console.log(JSON.stringify({stage:'prepared',maintenanceUploaded:uploaded.id,productionVersion:active.versions[0].version_id,prisoners:proof.prisoners.count,tables:Object.keys(proof).length,backupEncrypted:true}));
