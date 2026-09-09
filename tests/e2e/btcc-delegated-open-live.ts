import { runBtccR3ElectronHarness, BTCC_R3_ELECTRON_SCENARIO_SCHEMA } from "./btcc-r3-electron-harness.ts";

// Uses the real Composer, delegation, model, file tools, and parent result delivery.
const model = process.argv[2] ?? "openai/gpt-5.6-luna";
const result = await runBtccR3ElectronHarness({
  schema: BTCC_R3_ELECTRON_SCENARIO_SCHEMA,
  id: "delegated-open-continuation",
  model,
  reasoningEffort: "max",
  accessMode: "full_access",
  session: { kind: "chat", title: "위임 작업 중간 저장 후 완료 보고 확인" },
  fixtures: [{ path: "input.txt", text: "First marker: ORCHID\nSecond marker: MAPLE\n" }],
  steps: [{
    id: "open-continue-report",
    timeoutMs: 600000,
    reloadAfter: true,
    prompt: "격리된 개발 테스트입니다. 아래 요청을 그대로 Steward에게 위임하고 Worker는 사용하지 마세요. Steward가 input.txt를 읽고 first.txt에 첫 marker를, second.txt에 둘째 marker를 기록해야 합니다. 중간 저장 동작을 확인하려고 합니다: first.txt 작성 후 같은 Work에 record_work_disposition open을 한 번 기록하고 remaining_actions에 second.txt 작성, next_condition에 추가 승인 없이 즉시 계속한다고 적으세요. 이것은 사용자에게 멈춰 보고하라는 요청이 아닙니다. 같은 실행에서 second.txt까지 쓰고 두 파일 내용을 확인한 뒤 Work를 completed로 기록하고 두 marker와 파일명을 포함한 완료 보고를 Butler에게 하세요. 별도 원장 문서, 커밋, 배포, 독립 리뷰는 필요하지 않습니다.",
    expect: { terminalState: "delivered", stewardDelivered: true, finalIncludes: ["ORCHID", "MAPLE"] },
  }],
}, { model, reasoningEffort: "max", keepLogs: true, runRoot: process.argv[3] });
console.log(JSON.stringify({ ok: result.ok, evidencePath: result.evidencePath, observations: result.observations }));
if (!result.ok) process.exitCode = 1;
