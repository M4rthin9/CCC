import {writeFileSync} from 'node:fs';
import {api,worker,dbPath,loadPlan,savePlan,deploy,assert,sleep,exportSql,sqlite,tableProof,encrypt} from './prisoner-recovery-lib.mjs';
const plan = loadPlan();
const active = (await api(`${worker}/deployments`)).deployments[0];
assert(JSON.stringify(active.versions) === JSON.stringify(plan.originalVersions),'Production deployment changed since preflight');
plan.maintenanceActive = true;
plan.safeToReopen = true;
savePlan(plan);
await deploy([{version_id:plan.maintenanceVersion,percentage:100}],'Pause writes for prisoner data recovery');
let confirmed = false;
for (let i=0;i<20;i++) {
  const response = await fetch(`https://ccc-backend.pongsinbas.workers.dev/api/health?recovery=${Date.now()}`,{cache:'no-store'});
  if (response.status === 503 && response.headers.get('X-Prisoner-Recovery') === '20261016') {confirmed=true;break;}
  await sleep(2000);
}
assert(confirmed,'Maintenance response was not confirmed');
console.log('MAINTENANCE ACTIVE; allowing in-flight requests to finish');
await sleep(45000);
const first = await api(`${dbPath}/time_travel/bookmark`);
await sleep(10000);
const second = await api(`${dbPath}/time_travel/bookmark`);
assert(first.bookmark === second.bookmark,'Database still receiving writes; refusing historical restore');
const sql = await exportSql();
const proof = tableProof(sqlite(sql));
assert(proof.prisoners.count===1,'Prisoner list changed before recovery');
writeFileSync('frozen-database.sql',sql);
writeFileSync('frozen-proof.json',JSON.stringify(proof));
encrypt('frozen-database',sql);
plan.currentBookmark = (await api(`${dbPath}/time_travel/bookmark`)).bookmark;
plan.frozen = true;
savePlan(plan);
writeFileSync('recovery-artifacts/frozen-plan.json',JSON.stringify(plan,null,2));
console.log(JSON.stringify({stage:'frozen-backup-ready',bookmark:plan.currentBookmark,tables:Object.keys(proof).length,encrypted:true}));
