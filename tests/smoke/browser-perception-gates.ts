// test-category: pure-logic
import { strict as assert } from "node:assert";
import { readFile, writeFile } from "node:fs/promises";
import type { L1Metrics } from "../browser-eval/contracts";

const input=process.env.BUTLER_BROWSER_EVAL_OUTPUT, output=process.env.BUTLER_BROWSER_GATE_OUTPUT;
assert.ok(input); assert.ok(output);
const report=JSON.parse(await readFile(`${input}/l1.json`,"utf8")) as {rows: L1Metrics[]};
assert.equal(report.rows.length,20);
const failures: string[]=[];
for(const row of report.rows) {
  if(["F01","F02","F03","F16","F19"].includes(row.id) && row.decoysLeaked !== 0) failures.push(`${row.id}: decoy leak ${row.decoysLeaked}`);
  if(!["F09","F18"].includes(row.id) && row.realTargetRecall<.95) failures.push(`${row.id}: recall ${row.realFound}/${row.realTotal}`);
  if(["F02","F05","F06"].includes(row.id) && (row.coveredAnnotationAccuracy ?? 0)<.95) failures.push(`${row.id}: covered ${row.coveredCorrect}/${row.coveredTotal}`);
  if(row.snapshotTokensEstimate>4000) failures.push(`${row.id}: ${row.snapshotTokensEstimate} estimated tokens`);
}
for(const id of ["F04","F20"]) {
  const snapshot=JSON.parse(await readFile(`${input}/${id}.snapshot.json`,"utf8")) as {nodes:Array<{targetId?:string;ad:boolean}>};
  const truth=JSON.parse(await readFile(new URL(`../fixtures/browser/${id}/truth.json`,import.meta.url),"utf8")) as {targets:string[];decoys:string[]};
  for(const ad of truth.decoys) if(!snapshot.nodes.some(node=>node.targetId===ad && node.ad)) failures.push(`${id}: missing ad annotation ${ad}`);
  for(const node of snapshot.nodes) {
    if(node.targetId && truth.targets.includes(node.targetId) && node.ad) failures.push(`${id}: real target flagged ad ${node.targetId}`);
    if(node.targetId && truth.decoys.includes(node.targetId) && !node.ad) failures.push(`${id}: unflagged ad ${node.targetId}`);
  }
}
await writeFile(output,JSON.stringify({status:failures.length?"failed":"passed",failures},null,2));
assert.deepEqual(failures,[],"P2a-2 L1 acceptance gates");
