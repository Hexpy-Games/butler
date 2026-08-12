import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { JSDOM } from "jsdom";
import {
  assessM1V2LandingGrounding,
  extractM1V2LandingClaimElements,
} from "../support/agent-benchmark/m1-v2-landing-quality.ts";
import { readM1V2DbEvidence } from
  "../support/agent-benchmark/m1-v2-db-evidence.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("M1 v2 Butler quality evidence", () => {
  test("requires Butler-specific capability grounding and rejects generic or false copy", () => {
    const grounded = assessM1V2LandingGrounding([
      "Butler는 durable project Work의 검토를 유지합니다.",
      "Butler는 memory context를 활용합니다.",
      "도구는 workspace 권한 안에서 실행됩니다.",
      "provider routing으로 모델 경로를 선택합니다.",
      "실패 상태에서 재시작 복구를 지원합니다.",
    ]);
    expect(grounded).toMatchObject({
      durableProjectWorkGrounded: true,
      memoryContextGrounded: true,
      toolsWorkspaceGrounded: true,
      providerRoutingGrounded: true,
      recoveryGrounded: true,
      genericCopyAbsent: true,
    });
    expect(grounded.approvedCapabilityClaims.every((claim) => claim.passed)).toBe(true);

    const invalid = assessM1V2LandingGrounding([
      "혁신적인 AI 비서로 생산성을 극대화하세요.",
      "provider routing은 지원하지 않습니다.",
      "모든 memory context를 무제한 저장합니다.",
    ]);
    expect(invalid.genericCopyAbsent).toBe(false);
    expect(invalid.approvedCapabilityClaims.some((claim) =>
      claim.negated || claim.misrepresented)).toBe(true);
  });

  test("does not combine unrelated nested elements into one capability claim", () => {
    const document = new JSDOM(`
      <section>
        <p>Butler supports a durable project.</p>
        <p>Work review is available in another nested section.</p>
      </section>
    `).window.document;
    const extracted = extractM1V2LandingClaimElements(document);
    expect(extracted).toEqual([
      "Butler supports a durable project.",
      "Work review is available in another nested section.",
    ]);
    expect(assessM1V2LandingGrounding(extracted).durableProjectWorkGrounded).toBe(false);
  });

  test("collects product tool and SQLite integrity evidence without exporting content", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-benchmark-m1-db-"));
    roots.push(root);
    const runtime = join(root, "runtime");
    mkdirSync(runtime, { recursive: true });
    const db = new Database(join(runtime, "turns.sqlite"));
    db.exec(`
      CREATE TABLE btcc_guided_tool_calls (
        call_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL,
        tool_name TEXT NOT NULL, started_at INTEGER NOT NULL, result_json TEXT
      );
      INSERT INTO btcc_guided_tool_calls VALUES
        ('1', 'turn-target', 'web_search', 1, '{}'),
        ('2', 'turn-target', 'inspect_workspace_page', 2, '{}'),
        ('3', 'turn-target', 'run_command', 3, '{}'),
        ('4', 'turn-target', 'write_file', 4, '{}');
    `);
    db.close();
    const evidence = readM1V2DbEvidence(root, "turn-target");
    expect(evidence).toMatchObject({
      quickCheckDatabases: 1,
      quickCheckPassed: true,
      toolCalls: 4,
      webToolCalls: 1,
      pagePreviewToolCalls: 1,
      buildCommandToolCalls: 1,
      fileMutationToolCalls: 1,
    });
    expect(JSON.stringify(evidence)).not.toContain("turn-target");
  });
});
