# Windows token audit — 2026-10-04

## 결론과 증거 수준

최신 Windows 테스트 프로필의 **70회 요청 / 입력 1,462,423 / 캐시 194,944 / 비캐시 1,267,479 / 출력 20,332토큰**을 확인했습니다. 토큰 가중 캐시 적중률은 **13.33%**입니다(저장 normalized usage 기준). 짧은 사용자 메시지 길이가 아니라, 여러 도구·Work 처리 요청에 누적된 문맥이 입력량을 결정합니다. 두 대화의 세 Steward가 입력의 **83.14%**를 사용했습니다.

사용자의 **TypeScript 시절 연속 작업 >90% 캐시 적중**은 이 조사의 회귀 기준입니다. 당시 사용량 원본은 이번 자료에 없으므로 >90%를 재측정했다고 주장하지 않습니다. **확인된 Rust 회귀는 파일 변경 내역의 모델 재전송**입니다. **확인된 prefix 파괴는 최종 보고 단계의 tool schemas 제거**이며, 이것은 지정 TypeScript snapshot에도 있던 동작입니다. 작업 중 요청의 정적 prefix는 유지됩니다. 따라서 현재 자료만으로 **전체 86.67% 비캐시의 단일 Rust 원인을 확정할 수 없습니다**. “매 요청 timestamp/Work/tools 순서가 앞에서 바뀐다”는 설명은 관측 증거와 맞지 않습니다.

## 자료·범위·재현 방법

- 기준: `origin/main` = `ec138feae`; 실제 Windows build-info commit = `a1eae9119e2696eb94e76801011f3f85715c1183` (`win-fixes-5`, 2026-10-04 09:47:20 UTC).
- 비교: Rust cutover `f1173515c` 이전 TypeScript `37a530825`. 아래 TS 파일:행은 **37a530825**, Rust는 별도 표시가 없으면 **ec138feae** 기준입니다. 요청 serializer, stable-prefix, messages, GuidedPrompt/Steering/tools surface는 테스트 빌드와 동일합니다. Work/report 결정·driver·result parser는 후속 수정이 있으므로 테스트 빌드도 직접 확인했습니다.
- 허가된 최신 `%TEMP%/butler-win-protected-path-c74726151da04f09bb09a6e98d73a2db/data`만 조사했습니다. 실제 사용자 home 데이터·자격증명은 읽지 않았습니다. Windows 에이전트 중지·빌드·재실행·삭제를 하지 않았습니다.
- `metrics/prompt-cache-usage.jsonl` 70행, BTCC DB의 70 accepted rounds 및 140 route events, 10 Turns, 62 journal tools, 22 context documents, 3 session relations/delegations, transcripts의 저장된 전송 이벤트를 읽었습니다. SQLite는 URI `?mode=ro`, `PRAGMA query_only=ON`, read transaction으로 열었습니다. DB checkpoint를 실행하지 않았습니다.
- 집계 구간: **2026-10-04 10:28:22.974–10:54:03.245 UTC / 19:28:22.974–19:54:03.245 KST**. 실행 중 데이터이므로 이후 증가분은 이 snapshot에 포함하지 않습니다.
- UTF-8 usage text SHA-256: `a8d6f763704b015efd04b0c9a766f0a392789d2f932094dd6a18526a5688ae09`. 원본 데이터/프롬프트/파일 내용은 최종 보고서·브랜치 tree에 넣지 않았습니다. 시작 시 자동 WIP 커밋에 있던 `.audit-scratch`는 임시 분석 후 제거하며 그 WIP 이력도 최종 task branch에서 제외합니다.
- 각 usage 행을 `(turnId, roundIndex, promptTokens, cachedTokens, totalTokens)`로 DB `normalized_response_json.usage`와 대조하여 **70/70 완전 일치**했습니다. 출력은 `totalTokens - promptTokens`; DB `outputTokens`도 같은 합입니다. 전체 입력은 캐시를 포함합니다. 비캐시는 `input - cached`입니다. 출력의 reasoning 부분을 별도로 더하지 않았습니다.
- 재현 SQL: `btcc_model_round_acceptances JOIN btcc_turns USING(turn_id)`에서 `json_extract(normalized_response_json,'$.usage.promptTokens')`, `cachedTokens`, `outputTokens`를 `session_id,turn_id`로 합산합니다. journal count는 model request count와 다릅니다.
- 저장 로그 `logs/20261004T175429132/data-metrics/prompt-cache-usage.jsonl`은 더 이른 별도 실행의 **16회 / 입력 222,501 / 캐시 23,552**입니다. 최신 프로필과 합치지 않았습니다. transcripts의 outbound/delivery 이벤트도 모델 요청으로 세지 않았습니다.
- Windows `reg query HKCU\Software\Classes\butler /s`의 조사 전후 결과는 동일하며 기존 Squirrel 설치를 가리킵니다. 최종 검증의 byte SHA-256은 `ef277219e24fe60941ae62143b6569f3593000b2432a788b995e111963ddcd6b`입니다.

화면의 **1.42M / 비캐시 1.25M**과 정확히 일치하는 시각의 화면/API snapshot은 남아 있지 않습니다. 저장 순서상 67회 시점에는 입력 **1,430,536**, 캐시 **185,344**, 비캐시 **1,245,192**이고, 69회에는 **1,451,501 / 194,944 / 1,256,557**입니다. 이번 최신 70행 합계를 화면 숫자에 억지로 맞추지 않습니다. Settings의 formatter는 locale 의존 compact 표기이며 원본 정수 집계가 기준입니다 (`packages/butler-app/client/ui/src/components/settings/usageSettingsFormat.ts:9`, `UsageMonitorMetrics.tsx:20`; 입력 집계 `butler-runtime/src/operations/usage_cost.rs:58`).

## 대화별·세션별 합계

| 대화 (parent + 해당 Steward) | 요청 | 입력 | 캐시 | 비캐시 | 출력 | 캐시율 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Downloads 계획·정리 | 48 | 1,037,988 | 171,776 | 866,212 | 13,114 | 16.55% |
| Snake 및 파일 위치 후속 질문 | 22 | 424,435 | 23,168 | 401,267 | 7,218 | 5.46% |
| 합계 | 70 | 1,462,423 | 194,944 | 1,267,479 | 20,332 | 13.33% |

| 세션 별칭 / 역할 | 요청 | 입력 | 캐시 | 비캐시 | 출력 |
| --- | ---: | ---: | ---: | ---: | ---: |
| DP / Downloads parent | 15 | 173,002 | 28,800 | 144,202 | 3,491 |
| DI / Downloads 조사 Steward | 10 | 158,377 | 18,944 | 139,433 | 2,457 |
| DE / Downloads 실행 Steward | 23 | 706,609 | 124,032 | 582,577 | 7,166 |
| SP / Snake parent | 7 | 73,635 | 0 | 73,635 | 1,315 |
| SE / Snake 제작 Steward | 15 | 350,800 | 23,168 | 327,632 | 5,903 |
| `butler/main` 및 background/memory 전용 모델 scope | 0 | 0 | 0 | 0 | 0 |

세 Steward 합계: **48회 / 입력 1,215,786 / 캐시 166,144 / 출력 15,526**. Parent 합계: **22회 / 입력 246,637 / 캐시 28,800 / 출력 4,806**. worker 재위임 세션은 없습니다. `recall_memory`는 DE 내부의 도구 호출 1회이며 별도 메모리 모델 요청으로 이중 계상하지 않습니다. consolidation 저장 summary는 4 phases, 15ms, success이고, 이 snapshot의 모든 usage 행은 `phase=guided`, `openai/gpt-6.1-sol`, `authMode=subscription`입니다. 별도 추출·consolidation 모델 사용량은 관측되지 않았습니다. 모든 비계측 작업의 모델 사용 부재까지 증명하는 것은 아닙니다.

## Turn별 합계

| Turn | 세션 | 의미 | 요청 | 입력 | 캐시 | 출력 |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| D1 | DP | 정리 계획 요청·위임 | 4 | 44,071 | 9,600 | 774 |
| D2 | DI | Downloads 조사·계획 | 10 | 158,377 | 18,944 | 2,457 |
| D3 | DP | 조사 결과 disposition·보고 | 2 | 17,566 | 0 | 765 |
| D4 | DP | 정리 실행 요청·위임 | 7 | 90,400 | 9,600 | 1,371 |
| D5 | DE | Downloads 실행·확인 | 23 | 706,609 | 124,032 | 7,166 |
| D6 | DP | 실행 결과 disposition·보고 | 2 | 20,965 | 9,600 | 581 |
| S1 | SP | Snake 요청·위임 | 4 | 45,775 | 0 | 842 |
| S2 | SE | Snake 제작·확인 | 15 | 350,800 | 23,168 | 5,903 |
| S3 | SP | 제작 결과 disposition·보고 | 2 | 16,938 | 0 | 395 |
| S4 | SP | 파일 위치 질문, 목록 조회, 승인 대기 | 1 | 10,922 | 0 | 78 |

### 요청이 늘어난 경로

**70 = 도구를 선택한 요청 64 + 최종 자연어 보고 요청 6**입니다. 64회 모두 한 요청당 native tool call 1개입니다. 62 journal rows에 runtime reader `list_operation_results` 2회를 더하면 64가 됩니다. 도구 재개 때 모델을 다시 부르는 횟수와 승인 UI 전송 횟수를 혼동하지 않았습니다. Route events는 **started 70 / succeeded 70**, 전부 `transport_attempt=1`이며 provider retry/fallback 요청 증거는 없습니다.

| 요청 유형 | 요청 | 그 요청들의 입력 | 캐시 | 해석 |
| --- | ---: | ---: | ---: | --- |
| Work/Plan/review/checkpoint/disposition | 31 | 606,831 | 122,752 | 입력의 41.49%; 도구 응답·기존 history도 포함 |
| 최종 보고 (tools 제거) | 6 | 124,643 | 0 | 입력의 8.52%; 별도 final nudge 뒤 모델 호출 |
| 나머지 실행·조회·위임·todo | 33 | 730,949 | 72,192 | 실제 작업과 참조 읽기 |

31 bookkeeping calls는 `start_work` 3, `continue_work` 3, `replace_work_plan` 6, `record_work_review` 8, `record_work_checkpoint` 5, `record_work_disposition` 6입니다. Review 8회는 **Plan 6 / result 2**, 모두 accept입니다. 별도 reviewer 모델 호출은 없습니다. Discovery/reference 계열 9회는 위 표의 마지막 행에 포함됩니다.

최종 nudge는 **6회**입니다. 보존된 authority checkpoints의 user 메시지에는 **Work 전체 갱신 7개**(DI 2, DE 5)가 있고, 새 모델 요청을 따로 추가하는 대신 다음 요청의 history에 추가됩니다. checkpoint 밖의 갱신까지 포함한 전체 개수는 저장 요청 원문 부재로 확정하지 않습니다. 완료 후보를 거절하는 continuation/correction nudge만으로 발생한 독립 요청은 관측된 70회 중 **0회**입니다. `work/decision.rs:54` (Windows build)와 `agent_loop/driver.rs`의 correction path는 존재하지만 이번 요청 수의 별도 원인으로 세지 않습니다.

## 연속 요청 prefix 분석

### 실제 저장된 identity와 재구성된 byte 비교

`providerRouteIdentity`는 **최종 HTTP JSON의 tools부터 정적 instructionPrefix까지**의 길이·SHA-256을 저장합니다. full request 원문 또는 provider 내부의 rendered/token prefix는 저장하지 않습니다 (`butler-models/src/models/provider/serialize/stable.rs:55`). HTTP JSON 필드 순서 자체가 provider의 내부 token 순서를 지정하는 것은 아닙니다.

3개 authority checkpoint에서 tools, stable instructionPrefix, model, medium reasoning으로 byte prefix를 재구성하고 저장 SHA-256과 **3/3 정확히 일치**시켰습니다. 다음 prefix는 해당 Working rounds 동안 바뀌지 않습니다.

| 범위 | prefix bytes | prefix SHA-256 (식별용 앞 8자리) | Working rounds |
| --- | ---: | --- | --- |
| DP D1/D4/D6 및 S4 | 43,882 | `c04a07d0` | 각 Turn의 전체 Working 구간 |
| DI D2, DE D5 | 44,141 | `1e799af2` | 0–8, 0–21 |
| SP S1/S3 | 46,235 | `fb3b67c5` | 0–3, 0 |
| SE S2 | 45,996 | `631e88f6` | 0–13 |

**64 Working 요청 중 48회가 저장 cached=0**입니다. 10개 Turn의 최초 요청을 제외해도 **후속 Working 54회 중 38회가 0**입니다. 동일 정적 prefix 안에서도 예를 들어 D5 round 12→13은 캐시 **0→25,344**, 13→14는 **25,344→0**입니다. 변경되는 schema/order 또는 static instructions가 이 패턴의 원인이라는 증거는 없습니다. cache route, eligible message boundaries, provider 측 cache availability/보고 여부, 기록되지 않은 동적 instruction suffix 등의 영향은 분리 계측이 필요합니다. 동일 모델·scope·prefix 해시만으로 cache hit를 보장할 수 없습니다.

| 연속 요청 비교 | 최초 다른 위치 (UTF-8, 0-based) | 담당 필드·의미 | 근거 |
| --- | --- | --- | --- |
| D2 r0→r1 reconstructed `input` JSON | **6,848** | 첫 요청 끝 `]`가 append용 `,`로 바뀜; 기존 첫 user item 그대로 | 저장 messages, `serialize/messages.rs:5` |
| D5 r0→r1 reconstructed `input` JSON | **9,021** | 동일한 append 변화; 초기 prompt 앞에 삽입된 변경 없음 | 저장 messages, `agent_loop/state.rs:40`, `model_round.rs:246` |
| D2/D5 Working→FinalReport stable HTTP prefix | **28** | `"tools"`의 `s` → `"tool_choice"`의 `_`; tools 필드 전체 생략 | 재구성 prefix hash 일치, `host/guided/tools.rs:366`, `serialize.rs:118` |
| 다른 user Turn 시작 | 초기 `input`의 request text부터 | 새 사용자 요청/Work/context가 새로운 Turn의 첫 user message | `host/guided/prompt.rs:127`, `source_prompt` |

위 input offsets는 **저장된 checkpoint로 재구성한 subdocument**의 위치입니다. network body의 절대 byte offset이라고 주장하지 않습니다. 첫 request의 종료 bracket 차이는 대화 append의 정상 동작이며 이전 content prefix의 파괴가 아닙니다. 전체 입력의 earliest field difference를 모든 69쌍에 대해 제시하는 것은 full request가 없어서 불가능합니다.

FinalReport에서 capability digest는 공통 empty tools `4f53cda1…`로 바뀌고, prefix 길이는 Butler **4,561**, Steward **4,773/4,775 bytes**로 감소합니다. **6개 모두 cache=0 / 입력 합 124,643**입니다. 이것이 확인된 가장 이른 request 변화입니다. 다만 empty-tools profile의 coldness도 포함되므로 124,643 전체가 이 변경 때문에 비캐시였다고 확정하지 않습니다.

### 의심 항목별 판정

- **per-phase/progressive tools:** phase별 admission은 존재하지만 이번 Working 구간의 surface/capability digest는 고정입니다. `tool_search` 호출 이후에도 목록이 추가되지 않았습니다 (`guided_turn/phase/selection.rs:93`, `host/guided/tools.rs:365`). FinalReport에서만 0개로 전환합니다. 단계 축소가 매 호출 cache를 깬다는 가설은 이번 자료에서 기각합니다.
- **Work/plan/progress/timestamps:** 초기 request 뒤에 scope→Work→effects→plan→documents→attachments→prior tools 순서입니다 (`host/guided/prompt.rs:127`). 변경된 Work는 **tail user observation**으로 추가하고 기존 최초 메시지를 수정하지 않습니다 (`host/guided/steering.rs:56`, `agent_loop/state.rs:119`). per-round 앞쪽 wall-clock timestamp를 만드는 경로는 이 Guided serializer에서 찾지 못했습니다. Work에 timestamps/ids가 있더라도 append된 payload 내부의 데이터와 앞쪽 매 요청 timestamp는 다릅니다.
- **직렬화 불안정성:** ordered tools Vec, deterministic messages projection, stable-prefix check를 사용합니다 (`serialize/stable.rs:43`, `serialize/messages.rs:5`). HashMap이 일부 lookup에 있지만 지금 측정된 prefix의 schema ordering 흔들림은 없습니다. 저장 해시와 3개 재구성이 일치하므로 순서 randomization을 원인으로 단정할 수 없습니다.
- **prompt_cache_key:** Rust는 기본 prefix와 `btcc-guided:<session>` scope를 구성하여 body에 넣습니다 (`configuration/provider.rs:310`, `configuration/provider/policy.rs:50`, `serialize.rs:86`, `host/guided/prompt.rs:475`). usage 행에 key가 없는 것은 **`round_usage.rs:43`가 None으로 기록하는 계측 결손**이지 key 미전송 증거가 아닙니다. 실제 resolved key 값을 저장하지 않아 동일성은 source 기반 판단입니다.
- **previous_response_id/stored conversation:** 공식 API path에는 previous_response_id가 있지만 subscription은 이를 제거하고 `store=false` full stateless input을 보냅니다 (`serialize.rs:128`, `:178–184`). **TypeScript도 같은 제거를 했습니다**. 새 Rust regression으로 분류하지 않습니다. 억지로 store/previous_response_id를 추가하는 한 줄 변경은 해당 subscription 경로에서 안전하지 않습니다.
- **usage 값의 한계:** Rust SSE `butler-models/src/models/transport/sse.rs:172`는 completed usage에서 `input_tokens_details.cached_tokens`를 옮기고 decoder `provider/result.rs:446`(Windows build `:466`)는 missing cached를 0으로 정규화합니다. TS `integrations/providers/openai/codex-response-assembly.ts:22`도 같은 필드 재구성을 했습니다. 원본 SSE가 없어 저장 0이 provider의 명시적 0인지 누락값인지 알 수 없습니다. 이를 새로운 Rust 회귀나 실제 과금 캐시 미스로 확정하지 않습니다. 후속 계측은 cached-field presence와 raw numeric usage만 보존해야 합니다.
- **excerpts/compaction:** 저장 `btcc_context_compactions` **0 rows**, summary 모델 usage **0 rows**입니다. 초기 document/excerpt 길이 제한은 존재하나 매 round 앞에 새 compaction을 넣었다는 증거는 없습니다. reference replay의 old-output replacement는 일반적으로 prefix를 깨뜨릴 수 있지만 이 실행의 대형 journal 결과는 delivery state가 null이고 원문 content가 retained messages에 남아 있습니다.
- **continuation nudges:** Work refresh/final/correction 모두 history 끝에 append됩니다. Work refresh는 누적 입력을 늘립니다. Final nudge 자체보다 동반되는 tools 제거가 앞쪽 변화입니다. correction-only round 폭증 증거는 없습니다.

## TypeScript → Rust 비교와 확인된 회귀

아래 Rust 축약 경로는 `packages/butler-agent/rust/crates/`, TS 축약 경로는 `packages/butler-agent/src/` 아래입니다. Rust 참조의 `serialize/*`, `provider/result.rs`, `round_usage.rs`, `client.rs`는 `butler-models/src/models/provider/` 아래이며, `configuration/*`는 `butler-models/src/models/` 아래입니다. `host/guided/*`는 `butler-agent/src/` 아래, `agent_loop/*`는 `butler-turn/src/btcc/` 아래입니다. `guided_turn/phase/*`도 `butler-turn/src/btcc/` 아래입니다.

| 항목 | TS `37a530825` | Rust 테스트 빌드 / 현재 | 판정 |
| --- | --- | --- | --- |
| 정적 순서 | `integrations/providers/openai/stable-provider-prefix.ts:15`에서 model/tools/tool_choice/reasoning/instructions→나머지 | `butler-models/.../serialize/stable.rs:43` 동일 순서 | 회귀 확인 없음 |
| 동적 context 배치 | `agent/context/prompt-cache-policy.ts:44` 안정/동적 분류; Guided는 `agent/btcc/agent-loop/guided-turn-prompt.ts:77` request/scope/Work/context | `butler-agent/.../guided/prompt.rs:127` 비슷한 순서; profile/governing suffix도 instructions에 존재 | legacy prompt assembler와 Guided를 혼동하지 말아야 함 |
| per-session key | `integrations/providers/openai/model-config.ts:201`, `:227`, `:325`; home\|data hash + sanitized scope | `configuration/provider/policy.rs:50`; canonical data hash + same scoped pattern | key namespace는 cutover 때 바뀌나 이후 매 요청 변하지 않음; GPT-6.1에서 key 누락을 주원인으로 볼 근거 없음 |
| conversation state | API previous id 지원; `responses-client.ts:241` subscription은 false/stateless로 변환 | `serialize.rs:178` same false/stateless | 양쪽 full history 재전송; 새 missing-state regression 아님 |
| tools ordering/phase | frozen array, stable digest (`round-tool-surface.ts:16`); dynamic Work projection 및 final no-tools 존재 | Working binding Vec 고정, final no-tools | final prefix 파괴는 실재하지만 지정 TS snapshot에도 존재 |
| request excerpts/compaction | `agent-loop.ts:78` replay→bounded projection; compact semantic history | `model_round.rs:107` replay→context→send | 관련 기능 양쪽 존재; 이번 persisted compaction은 0 |
| 파일 mutation 결과 | **`tool-result-message.ts:44`, `:85`의 `withoutChangedFileDetails`가 `changed_file/changed_files/changedFiles`를 재귀 제거** | **`butler-agent/.../tools/message.rs:43, :81`이 output 전체 삽입; `message/preview.rs:90`은 50KiB 이하 generic result 그대로 반환** | **확인된 내용 중복 회귀** |
| cache-key diagnostics | `integrations/providers/openai/usage.ts:52` effective key 기록 | **`butler-models/.../round_usage.rs:43` None** | 확인된 관측성 회귀; 캐시 미스 원인 자체는 아님 |

## 큰 내용의 반복 재전송

1. **Snake write/edit의 App 전용 diff가 모델 context에 다시 들어갑니다.** Raw result의 `changed_file`은 write **23,434 UTF-8 bytes**, edit **17,114 bytes**(compact JSON 기준)입니다. write는 `lines` 약 14.8KB + `after_text` 약 8.5KB, edit는 `before_text` 약 8.5KB + `after_text` 약 8.5KB입니다. 모델은 이미 write의 full content/edited replacement를 tool arguments로 제출했습니다. UI diff는 별도 저장되어야 하며 모델에게 파일 전체를 또 보여줄 이유가 없습니다. 입력은 write 후 **13,374→23,374**, edit 후 **23,374→29,094**로 증가했습니다. 이 delta에는 arguments·response·Work observation도 포함되므로 전부 diff 토큰이라고 세지 않습니다.
2. **Downloads의 command/file outputs가 stateless history에 반복됩니다.** D5의 retained checkpoint 기반 reconstruction에서 25,724-byte command result는 이후 **15 요청**, 24,631-byte result는 **8 요청**, 18,387-byte read result는 **9 요청**의 input에 포함되는 구조입니다. 반복 노출량은 각각 **385,860 / 197,048 / 165,483 bytes**입니다. network capture가 아니라 persisted content+accepted ordinal에 근거한 reconstruction입니다. 해당 경로는 이미 받은 내용을 prefix로 재전송하므로 정상 캐시가 작동하면 비용 대부분을 피할 수 있습니다. 무조건 삭제하면 작업 품질/증거 재읽기가 악화됩니다.
3. **Work 갱신은 전체 Plan/진행 요약을 누적합니다.** DE checkpoint에 업데이트 5개, 합 **19,783 chars**, DI 2개 **5,724 chars**가 보존되어 이후 요청에 들어갑니다. 최신 state만으로 대체하기 위해 오래된 앞쪽 메시지를 매번 rewrite하면 prefix 손실이 커질 수 있습니다. 앞으로 append할 때 변한 사실만 넣는 방식을 검토해야 합니다.
4. **delegated brief는 초기 메시지에 한 번 삽입되고 매 stateless 요청에 재전송됩니다.** DI initial user content 3,821 chars / DE 5,395 chars입니다. 같은 call에 brief를 여러 user blocks로 중복 삽입하는 증거는 없습니다. 초기 request+Work+plan에 일부 의미 중복은 있지만 authority/source 정보 전체를 삭제할 근거는 아닙니다.
5. **전체 transcript JSONL 파일을 매 호출 그대로 붙인 증거는 없습니다.** 파일 크기나 progress 이벤트 수와 prompt tokens를 혼동하지 않습니다. 도구 `read_conversation_session`의 읽기 결과는 DE history에 들어갑니다. 대화 문맥은 admitted bounded docs 및 현재 Turn messages이며, 최근 대화/Hot Cache의 초기 변경은 다른 Turn 간 재사용 가능 suffix를 줄일 수 있습니다.

## 수정 제안 — 적중률 회복 및 토큰 절감 순서

비율은 이번 **총 입력 1,462,423 / 비캐시 1,267,479**를 분모로 한 별도 counterfactual입니다. 서로 겹치므로 합산하면 안 됩니다. provider 실측 없이 회복률을 보장하지 않습니다. cache 회복은 총 입력을 줄이는 것이 아니라 비캐시 과금·전처리량을 줄입니다.

| 우선순위 | 제안 | 절감 추정 / 회복 가능 범위 | 안전한 한 줄? |
| --- | --- | --- | --- |
| 1 | **Working cache 미스의 실제 경계 계측 후 고정 prefix 유지**: model/tools/instructions/input item 각각의 길이/hash, initial stable endpoint, auth route, resolved key hash, prior/current full prefix LCP, provider-reported cache boundary를 개인정보 없이 비교; mismatch가 확인된 필드만 수정 | **80–90% token-weighted hit** 시 비캐시 **76.92–88.46%** 절감(약 **975K–1,121K**). 기대 목표이지 이 자료로 확정된 한 원인/효과가 아님 | **아니요**; cache-key None만 채우는 것은 계측 수정이며 절감 0% |
| 2 | **TS의 App diff 분리 계약 복원**: write/edit provider projection에서 changed_file 세 가지 spelling 재귀 제외; App/원본 journal/파일 evidence는 보존 | 입력 **약 6–12%** 추정. write 결과 9회, edit 8회 재전송 시 diff 객체 **347,818 bytes**의 모델 중복 노출 제거; 2–4 UTF-8 bytes/token 가정 **87K–174K**. 실제 tokenizer/replay로 확인 필요 | **아니요**; 작은 정확한 projection 변경이지만 nested outputs와 UI evidence 보존 검증 필요 |
| 3 | **FinalReport의 tool definitions 유지 + tool execution 차단 분리**: 동일 schemas를 유지하고 지원되는 provider/tool policy로 최종 prose를 강제; runtime도 실행 금지 | 확인된 final input **124,643** 중 90–95% 재사용 시 비캐시 **8.85–9.34%** 절감. **상한 9.83%**; 다른 coldness와 겹침 | **아니요**; tools Vec 그대로 유지 한 줄만 바꾸면 다시 도구를 호출할 수 있음. `tool_choice=none` 자체도 prefix 설정 영향 검증 필요 |
| 4 | **선택적 기록의 모델 왕복 묶기**: result review 2회·checkpoints 5회를 계획 의미·필수 승인과 분리하여 필요할 때만 기록; 여러 독립 bookkeeping calls batch; disposition/effect guard 유지 | 이 **7 요청의 직접 입력 248,987 (17.03%)**이 최대 제거 대상. 실제 입력 **5–15%** 절감 후보 + 후속 history 감소. 필수 Plan review 6회/closeout 6회를 무조건 생략하지 않음 | **아니요**; durable ordering/authority를 검증해야 함 |
| 5 | **Work state delta를 append**: 전체 render 대신 stage/action/result 변경만, 최초 정확한 Work/Plan identity와 source-read 경로 유지 | 초기 checkpoint 자료 기반 **2–5% 입력** 가설; 새 tokenizer 측정 필요. 이미 보낸 앞 history의 임의 rewrite 금지 | **아니요** |
| 6 | **공통 정적 지침/스키마를 동적 persona·EOL·excerpts보다 앞에 유지**, 같은 정책 profile에서만 versioned deterministic schemas 재사용 | 기존 정적 순서는 이미 준수. 추가 분리의 현재 확정 절감은 **0%**; cross-Turn/phase cold input 합 **109,015 (7.45%)**보다 큰 “cold-start만의 절감”을 주장할 수 없음 | **아니요**; EOL/authority/phase semantics 보존 필요 |
| 7 | **prompt_cache_key를 새로 추가 / previous_response_id를 강제 / 앞 timestamp 삭제** | key는 이미 생성, subscription previous id 제거는 TS와 동일, 앞 timestamp 삽입은 미확인. **입증된 절감 0%**; 우선 구현 대상으로 부적절 | **아니요** |

1번은 코드 수정을 추측해서 시작하는 제안이 아니라 **현 48 Working zero-cache 요청의 원인을 분리하는 계측 prerequisite**입니다. >90% baseline 회복을 전체 schema 교체나 context 삭제만으로 약속하지 않습니다. 2번이 현재 바로 구현 계약을 정할 수 있는 가장 확실한 Rust 회귀 수정입니다. safe one-line **behavior fix는 확인하지 못했으므로 이 작업에서는 코드 변경을 하지 않습니다**.

공식 OpenAI 문서는 rendered prefix에 tools/instructions/history가 포함되며 tool names/order/settings 변경이 재사용을 막을 수 있다고 설명합니다. GPT-5.6 이후는 1,024-token 최소 prefix와 eligible message ending 기반 implicit boundaries를 사용하고, prompt_cache_key는 cache accounting용이며 자동 routing을 개선하기 위해 필수인 key가 아닙니다. 이것을 subscription 내부 구현이 API와 완전히 같다는 증명으로 사용하지 않습니다. [OpenAI Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)

## 후속 수정의 승인 기준과 이번 작업의 한계

- stub/replay E2E에서 같은 Turn의 Working 요청을 append-only로 비교하고, final tools/allowed execution boundary를 함께 검증합니다. byte hash 외에 item counts/order/full latest state도 검증합니다.
- write/edit은 App의 full diff를 유지하고 모델 projection에서 UI-only detail만 제외하는 public-path replay를 검증합니다. 모델이 이미 본 파일 내용·evidence identity/원본 읽기 권한은 보존합니다.
- 실제 cached-token 회복 측정은 추후 승인된 동일 모델·auth route의 Windows live campaign에서 수행합니다. 이번 작업은 live model 호출을 하지 않았습니다. cassette 기록이 필요하면 repo 규칙에 따라 `openai/gpt-6-luna`만 사용하고, stub/replay 성공을 실제 cache 적중의 증거로 대체하지 않습니다.
- **미완료 증거**: full serialized request를 저장하지 않아 모든 연속 쌍의 절대 byte LCP와 provider 내부 prefix boundary/route는 복원할 수 없습니다. 계측 추가 위치는 `butler-models/src/models/provider/client.rs:85`, `round_usage.rs:43`; required follow-up을 명시하고 원인을 추측으로 확정하지 않습니다.
- **미확인**: 보고된 1.42M의 정확한 화면 시각, TS >90% 원본 records, provider-side subscription caching 정책, 계측 밖 background usage. 저장된 70행과 확인된 코드 경로 이상의 주장은 하지 않습니다.
- 소유자 규모에서는 원문 prompt logging/매 호출 전체 DB scan을 추가하지 않습니다. request 준비 시 메모리에 이미 존재하는 sections의 bounded hashes와 lengths만 기록하고 개인 내용/key를 노출하지 않아야 합니다.

## 검증·전달

- 저장 usage ↔ DB accepted rounds: **70/70 행별 일치**, 합계 및 70행 보고서 arithmetic 확인 **PASS**.
- 저장 prefix 재구성: **3/3 SHA-256 및 byte length 일치**, reconstructed initial input append-only 비교 **PASS**.
- Windows registry 전후 byte 비교 **PASS**; owner agent를 시작/중지하거나 profile·registry를 수정하지 않았습니다.
- 격리 `cargo +1.91.0 fmt --manifest-path packages/butler-agent/rust/Cargo.toml --all -- --check`: **PASS**.
- 격리 Rust workspace에서 `cargo +1.91.0 run -p butler-source-check -- .`: **PASS**. Tests **499**, baseline unmarked **393**, test ratchet violations **0**, architecture violations **0**, E2E gate violations **0**.
- 최초 repo root 실행은 기본 rustc 1.90으로 package가 요구하는 1.91을 만족하지 않아 실행 불가였습니다. 1.91을 명시한 root scan도 scanner의 workspace-root 기준과 맞지 않아 잘못된 platform 경로 오류를 냈습니다. 코드·ratchet 변경 없이 pinned toolchain과 실제 Rust workspace에서 위 검증을 완료했습니다. 테스트 실패를 재시도한 것이 아닙니다.
- 최초 commit hook의 lint는 **0 errors / 28 warnings**, typecheck는 UI 의존성(`vite`, `react`, `zustand` 등) 미설치로 **FAIL**입니다. 이 hook 호출에 temp HOME/BUTLER_DATA를 전달하지 못한 절차 실수가 있었으며 격리 검증으로 인정하지 않습니다. 훅은 lint/typecheck만 실행했고 테스트는 실행하지 않았습니다. 이후 commit은 fresh temp HOME/BUTLER_DATA로 실행하며, 사용자가 허용한 환경 실패 예외에 따라 `--no-verify`를 사용합니다. TS/UI 변경이나 의존성 설치를 조사 범위에 추가하지 않습니다.
- `git diff --check`: **PASS**. 최종 push 전 `git fetch origin`: main은 `ec138feae`로 변하지 않았습니다.
- 문서만 변경했으므로 touched Rust crate/TS/UI는 없고 clippy·Bun/UI smoke·E2E 실행·Windows build/CI는 적용 대상이 없습니다. E2E/test-category ratchet 및 코드 shape 변경도 없습니다. PR/tag/merge를 하지 않습니다.
- task-owned `target/`와 private 분석 임시 파일은 전달 후 정리합니다. 원격 task branch의 기존 자동 WIP를 exact lease로 보고서 커밋으로 교체합니다.

## 식별자와 request 상세

Session suffix로 원본의 `scope=btcc-guided:<session>`를 확인할 수 있습니다.

| 별칭 | runtime session id |
| --- | --- |
| DP | `butler/app-chat-d3ae334e-92fd-4a1b-97a5-cd7099792c86` |
| DI | `steward-ee4d2ccf84c95a3b0b16e6f40efb1631` |
| DE | `steward-a8a7ffe8fa3cb913a2dafc8292fb00f5` |
| SP | `butler/app-project-33a4f618-8085-45e7-b860-e85e7225372e` |
| SE | `steward-d0e9e532e4ea136e041cacd4f8d42f89` |

| Turn | canonical turn id |
| --- | --- |
| D1 | `turn-1ccf8a96-d829-4a77-afa1-fb591ab0ae09` |
| D2 | `steward-turn-9be3397ca421ec3205368d69ed69524c` |
| D3 | `turn-e11e8d43-678e-4752-96f6-0dac94773657` |
| D4 | `turn-41f49d65-6677-426a-a881-b79747dfac6e` |
| D5 | `steward-turn-223b4a14ec755ef5c0a6eac2f471943a` |
| D6 | `turn-c7c0d05e-512a-42ea-b178-de7c8f2c4696` |
| S1 | `turn-5d331383-f479-4486-8021-a1190e2dc8fa` |
| S2 | `steward-turn-a236334a72c17666e5b72a19a74e2745` |
| S3 | `turn-be0e45f2-26ff-4b91-9a75-6055366d5221` |
| S4 | `turn-11dc152c-4a20-4040-8bd5-6a7f5a40a88e` |

아래 request는 accepted rounds와 usage를 대조한 값입니다. Round는 Turn 내부의 0-based index입니다.

| Turn | Round | 입력 | 캐시 | 출력 | native call / 보고 |
| --- | ---: | ---: | ---: | ---: | --- |
| D1 | 0 | 10,051 | 0 | 101 | start_work |
| D1 | 1 | 10,500 | 9,600 | 241 | replace_work_plan |
| D1 | 2 | 11,388 | 0 | 83 | record_work_review |
| D1 | 3 | 12,132 | 0 | 349 | delegate_to_steward |
| D2 | 0 | 9,527 | 0 | 62 | continue_work |
| D2 | 1 | 9,714 | 0 | 200 | replace_work_plan |
| D2 | 2 | 11,287 | 0 | 93 | record_work_review |
| D2 | 3 | 12,776 | 0 | 42 | tool_search |
| D2 | 4 | 13,621 | 0 | 273 | run_command |
| D2 | 5 | 18,176 | 0 | 475 | run_command |
| D2 | 6 | 20,034 | 0 | 181 | record_work_checkpoint |
| D2 | 7 | 21,484 | 12,672 | 131 | record_work_review |
| D2 | 8 | 23,135 | 6,272 | 178 | record_work_disposition |
| D2 | 9 | 18,623 | 0 | 822 | final report |
| D3 | 0 | 11,513 | 0 | 184 | record_work_disposition |
| D3 | 1 | 6,053 | 0 | 581 | final report |
| D4 | 0 | 11,783 | 0 | 25 | tool_search |
| D4 | 1 | 12,192 | 0 | 55 | list_operation_results |
| D4 | 2 | 12,258 | 0 | 284 | steer_steward |
| D4 | 3 | 12,613 | 0 | 105 | start_work |
| D4 | 4 | 13,033 | 0 | 230 | replace_work_plan |
| D4 | 5 | 13,892 | 9,600 | 79 | record_work_review |
| D4 | 6 | 14,629 | 0 | 593 | delegate_to_steward |
| D5 | 0 | 10,231 | 0 | 57 | continue_work |
| D5 | 1 | 10,408 | 0 | 46 | recall_memory |
| D5 | 2 | 10,554 | 0 | 25 | list_conversation_sessions |
| D5 | 3 | 10,985 | 0 | 58 | read_conversation_session |
| D5 | 4 | 11,473 | 6,272 | 33 | list_operation_results |
| D5 | 5 | 11,544 | 0 | 192 | replace_work_plan |
| D5 | 6 | 13,608 | 0 | 88 | record_work_review |
| D5 | 7 | 15,638 | 10,368 | 202 | run_command |
| D5 | 8 | 22,477 | 0 | 49 | tool_search |
| D5 | 9 | 23,434 | 0 | 592 | record_work_checkpoint |
| D5 | 10 | 25,504 | 6,272 | 1,383 | run_command |
| D5 | 11 | 28,395 | 6,272 | 91 | read_file |
| D5 | 12 | 29,918 | 0 | 100 | list_files |
| D5 | 13 | 30,658 | 25,344 | 109 | read_file |
| D5 | 14 | 37,687 | 0 | 1,224 | run_command |
| D5 | 15 | 44,936 | 11,392 | 280 | run_command |
| D5 | 16 | 46,358 | 0 | 88 | record_work_checkpoint |
| D5 | 17 | 48,335 | 6,272 | 1,172 | run_command |
| D5 | 18 | 51,722 | 22,272 | 98 | record_work_checkpoint |
| D5 | 19 | 53,558 | 0 | 586 | run_command |
| D5 | 20 | 56,360 | 23,296 | 132 | record_work_review |
| D5 | 21 | 58,410 | 6,272 | 170 | record_work_disposition |
| D5 | 22 | 54,416 | 0 | 391 | final report |
| D6 | 0 | 13,157 | 9,600 | 203 | record_work_disposition |
| D6 | 1 | 7,808 | 0 | 378 | final report |
| S1 | 0 | 10,485 | 0 | 132 | start_work |
| S1 | 1 | 10,946 | 0 | 217 | replace_work_plan |
| S1 | 2 | 11,785 | 0 | 96 | record_work_review |
| S1 | 3 | 12,559 | 0 | 397 | delegate_to_steward |
| S2 | 0 | 9,962 | 0 | 50 | continue_work |
| S2 | 1 | 10,125 | 0 | 31 | list_files |
| S2 | 2 | 10,525 | 0 | 166 | replace_work_plan |
| S2 | 3 | 11,621 | 0 | 74 | record_work_review |
| S2 | 4 | 12,644 | 0 | 63 | update_todo_list |
| S2 | 5 | 13,374 | 0 | 2,725 | write_file |
| S2 | 6 | 23,374 | 0 | 55 | edit_file |
| S2 | 7 | 29,094 | 0 | 84 | run_command |
| S2 | 8 | 29,542 | 0 | 22 | tool_search |
| S2 | 9 | 29,595 | 0 | 72 | record_work_checkpoint |
| S2 | 10 | 30,590 | 0 | 1,002 | run_command |
| S2 | 11 | 33,842 | 0 | 949 | run_command |
| S2 | 12 | 36,790 | 0 | 110 | update_todo_list |
| S2 | 13 | 37,533 | 23,168 | 157 | record_work_disposition |
| S2 | 14 | 32,189 | 0 | 343 | final report |
| S3 | 0 | 11,384 | 0 | 145 | record_work_disposition |
| S3 | 1 | 5,554 | 0 | 250 | final report |
| S4 | 0 | 10,922 | 0 | 78 | list_files |
