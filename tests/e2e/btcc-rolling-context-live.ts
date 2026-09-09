import { runBtccR3ElectronHarness, BTCC_R3_ELECTRON_SCENARIO_SCHEMA } from "./btcc-r3-electron-harness.ts";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { existsSync } from "node:fs";

// Real selected model + real composer ingress. The smaller input envelope makes
// the existing long-history incident reproducible without an hour-long job.
const model = process.argv[2] ?? "openai/gpt-5.6-luna";
const reasoningEffort = model.includes("luna") ? "max" : "medium";
process.env.BUTLER_BOUNDED_STATELESS_CONTEXT = "1";
process.env.BUTLER_CONTINUATION_MAX_MODEL_FACING_BYTES = "98304";
const result = await runBtccR3ElectronHarness({
  schema: BTCC_R3_ELECTRON_SCENARIO_SCHEMA,
  id: `rolling-context-${model.split("/").at(-1)}`,
  accessMode: "full_access", model, reasoningEffort,
  session: { kind: "chat", title: `긴 작업 이력 압축 확인 ${model}` },
  fixtures: Array.from({ length: 8 }, (_, i) => ({ path: `context-${i}.txt`,
    text: `Record ${i}. Marker: ORCHID-${i}.\n` + Array.from({ length: 128 }, (_, line) =>
      `Observation ${line}: parser API remains stable; source ${i} has sample ${line}; ${"reference information ".repeat(5)}`,
    ).join("\n") + `\nNext file: ${i < 7 ? `context-${i + 1}.txt` : "END"}\n`,
  })),
  steps: [{ id: "read-summarize-retrieve", timeoutMs: 600000, reloadAfter: true,
    prompt: "컨텍스트 압축 동작을 확인하는 읽기 작업입니다. 위임하지 말고 현재 모델이 직접 처리하세요. context-0.txt부터 시작해서 파일 전체를 read_file로 읽고 마지막의 Next file을 따라 다음 파일을 읽으세요. 다음 경로는 해당 파일에서 얻은 뒤에 읽어야 합니다. END까지 처리한 다음 list_operation_results에서 context-0.txt를 검색하고 read_operation_results로 그 원래 요청(source=request)과 첫 결과 페이지(source=result)를 다시 읽어 확인하세요. 파일 수정, 별도 리뷰, 테스트, 원장 생성은 하지 마세요. 마지막에 원문에서 회수한 첫 marker와 마지막 marker, 이전 결과를 다시 실행하지 않고 읽었음을 간단히 답하세요.",
    expect: { terminalState: "delivered", finalIncludes: ["ORCHID-0", "ORCHID-7"] },
  }],
}, { model, reasoningEffort, keepLogs: true, runRoot: process.argv[3] });
console.log(JSON.stringify({ ok: result.ok, evidencePath: result.evidencePath,
  observations: Array.isArray(result.observations) ? result.observations.map(({ terminalState, finalText, reload }: Record<string, unknown>) => ({ terminalState, finalText, reload })) : [] }));
if (result.ok !== true) process.exitCode = 1;
// The harness result supplies its run path; keep original diagnostics private.
const root = process.argv[3];
if (root) {
  const dbPath = join(root, "data", "agent-runtime", "btcc.sqlite");
  if (existsSync(dbPath)) {
    const db = new Database(dbPath, { readonly: true });
    try {
      const compactions = db.query<{ count: number }, []>("SELECT count(*) AS count FROM btcc_context_compactions").get()!.count;
      const reads = db.query<{ request: number; result: number }, []>(`SELECT
        COALESCE(SUM(json_extract(arguments_json, '$.source') = 'request'), 0) AS request,
        COALESCE(SUM(json_extract(arguments_json, '$.source') = 'result'), 0) AS result
        FROM btcc_guided_tool_calls WHERE tool_name = 'read_operation_results' AND status = 'completed'
          AND json_extract(result_json, '$.encoding') = 'base64'`).get()!;
      console.log(JSON.stringify({ compactions, originalReads: reads }));
      if (!compactions || !reads.request || !reads.result) process.exitCode = 1;
    }
    finally { db.close(); }
  }
}
