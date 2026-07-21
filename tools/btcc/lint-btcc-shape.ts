#!/usr/bin/env bun
import { inspectBtccSourceShape } from "./source-shape/index.ts";

const report = inspectBtccSourceShape(process.cwd());

if (report.findings.length > 0) {
  for (const finding of report.findings) {
    console.error(`${finding.path}: [${finding.code}] ${finding.message}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `BTCC source shape passed (${report.inspectedDomains} domains, ${report.inspectedFiles} files).`,
  );
}
