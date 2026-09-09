import { existsSync, writeFileSync } from "node:fs";
import {
  admitProjectLedgerEffectOccurrence,
  ProjectLedgerEffectConflictError,
} from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/external-effect-occurrence.ts";

const [inputPath, readyPath, startPath] = process.argv.slice(2);
if (!inputPath || !readyPath || !startPath) throw new Error("worker arguments missing");
const input = await Bun.file(inputPath).json();
writeFileSync(readyPath, "ready\n");
while (!existsSync(startPath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
try {
  const occurrence = admitProjectLedgerEffectOccurrence(input);
  const attempt = occurrence.attempts[0]!;
  console.log(JSON.stringify({ status: "admitted", requestSha256: attempt.requestSha256, publicationId: attempt.publicationId }));
} catch (error) {
  if (error instanceof ProjectLedgerEffectConflictError) {
    console.log(JSON.stringify({ status: "conflict", code: error.code }));
  } else {
    throw error;
  }
}
