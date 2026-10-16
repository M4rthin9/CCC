export const columns = ['prisonerId','prisonerName','wing','status','vinaiDate','note'];
export const normalize = row => columns.map(c=>row[c]);
export const quote = value => "'" + String(value).replaceAll("'","''") + "'";
export function insertStatement(rows) {
  return `INSERT INTO prisoners (${columns.join(',')}) VALUES ` + rows.map(row=>'('+normalize(row).map(quote).join(',')+')').join(',') + ' ON CONFLICT(prisonerId) DO NOTHING';
}
export function insertBatches(rows) {
  const batches=[];
  let batch=[];
  for(const row of rows) {
    if(batch.length && (batch.length===100 || Buffer.byteLength(insertStatement([...batch,row]),'utf8')>60000)) {
      batches.push(batch);
      batch=[];
    }
    batch.push(row);
  }
  if(batch.length) batches.push(batch);
  return batches;
}
