import {existsSync,writeFileSync,readFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {api,worker,dbPath,query,loadPlan,savePlan,deploy,assert,exportSql,sqlite,tableProof} from './prisoner-recovery-lib.mjs';
if(!existsSync('recovery-plan.json')) process.exit(0);
const plan=loadPlan();
if(!plan.maintenanceActive) process.exit(0);
if(plan.historical || !plan.safeToReopen) {
  assert(plan.currentBookmark,'Current database bookmark missing; do not reopen');
  await api(`${dbPath}/time_travel/restore?bookmark=${encodeURIComponent(plan.currentBookmark)}`,{},'POST');
  const baseline=JSON.parse(readFileSync('frozen-proof.json','utf8'));
  assert(isDeepStrictEqual(tableProof(sqlite(await exportSql())),baseline),'Fallback restore verification failed; keep maintenance active');
  plan.historical=false;
  plan.safeToReopen=true;
  savePlan(plan);
}
await deploy(plan.originalVersions,'Resume original production version after prisoner recovery');
const active=(await api(`${worker}/deployments`)).deployments[0];
assert(isDeepStrictEqual(active.versions,plan.originalVersions),'Original production version not restored');
plan.maintenanceActive=false;
savePlan(plan);
const count=(await query('SELECT count(*) AS count FROM prisoners'))[0].count;
const result={productionResumed:true,recoveryComplete:plan.complete,prisoners:count,versions:active.versions};
writeFileSync('recovery-artifacts/final-status.json',JSON.stringify(result,null,2));
console.log('FINAL STATUS',JSON.stringify(result));
assert(!plan.complete || count===6319,'Completed recovery count mismatch');
