# 좋은 오후 인사 — 마지막 Qwen 실행 진단

## 조사 범위와 방법

2026-09-09 운영 기록을 읽기 전용으로 대조했다. 세션 제목 확인 → parent/child 관계 확인 → 도구 및 상태 이력 → 실제 provider/최종 전달 → 코드 경로 및 산출물 근거 비교 순으로 조사했다. 서비스나 모델을 재실행하거나 코드를 수정하지 않았다. 뉴스의 현재 진위에 관한 독립 웹 검증이 아니라, 당시 모델이 실제로 받은 근거와 주장 사이의 일치 여부를 평가한다.

- Chat: chat-e8befa73-507f-41bd-8522-aea51cf52607
- 재시도 parent: turn-3a556603-12a8-4b3a-bb1b-b649929003d3
- Relation: relation-877cffd71aa405111afab1095b4b0dfea1984e7c
- Steward: steward-turn-a685ea83ceebae8fba87f096396dc110
- 결과 수신 parent: turn-afc29d1c-4e02-4bd7-8803-9331d6645194
- 출처: ~/.butler/agent-runtime/btcc.sqlite (turns, relations, directions, guided_tool_calls, progress_events, works, disposition_revisions), transcripts, app/developer-logs/model-turns.jsonl, metrics/prompt-cache-usage.jsonl.

## 시간순 결과 (KST)

| 시간 | 실제 기록 |
| --- | --- |
| 22:36:18–34 | Butler가 기존 Work를 재개하고 Steward를 한 번 위임 |
| 22:37:38–49 | Steward 계획 수립, 계획 승인, execution 진입 |
| 22:38–46 | 검색 14회, 본문 읽기 19회. 본문 읽기 11회 실패 |
| 22:46:44 | 첫 write_file 거절: effect_action_not_found |
| 22:47:04–33 | 효과 표시를 추가하여 계획 교체, 재승인. planning → execution |
| 22:48:15 | 파일 실제 작성 성공: news-briefing-2026-09-09.md, 4450 bytes |
| 22:50:36 | 파일 다시 읽기 성공, 쓰기와 읽기 SHA 일치 |
| 22:50:43–51:08 | result review → validation, completion review → reporting, disposition → completed |
| 22:51:45 | Steward 성공 보고 전달 |
| 22:51:50 | 런타임이 parent Work 모든 액션을 done으로 정리하고 completed 기록 |
| 22:52:41 | Butler가 실제 브리핑 대신 “결과물 파일이 실제로 잘 쓰였는지 먼저 확인하고 브리핑 정리해서 가져오겠다”는 예고문만 전달 |

결론: Steward의 파일 생성/종결은 성공했으나, 사용자에게 요청한 브리핑을 전달하는 전체 목표는 완료되지 않았다. 상태 completed는 결과 품질이나 전달 완성도를 보장하지 못했다.

## 반복 지시와 상태 전이

이 relation에는 delegation 1건, 추가 directions 0건이다. 중복 지시 실행의 증거는 없다. 대신 replace_work_plan이 2회 실행되었고, 각각 conception + planning 활동을 발행했다. `projection/projection.ts:278` 부근은 replace_work_plan 때마다 새 conception 활동을 만들며, `guided-activity-content.ts:65` 부근은 objective 전체를 요약으로 사용한다. 이 때문에 같은 위임 요청이 다시 활동 내역에 나타난다. UI의 특정 사용자 표현과 정확히 같은 라벨은 확인하지 못했지만 반복되는 요청 본문은 이벤트 원장에서 확인했다.

상태 전이가 영구 실패한 것은 아니다. 파일 작성 액션 설명은 있었지만 최초 계획에 구조화된 effect가 없었다. effect 검사(`effects/resolve-reviewed-effect.ts:96`)가 거절했고, Qwen은 plan 교체와 승인 후 복구했다. 최초 write_file에서 성공까지 약 91초가 더 걸렸다. 이 재계획은 실제 단계 회귀이며 반복 표시를 유발했다.

검색 중 checkpoint 호출은 0회였다. 초기 “이전 시도 검색 결과 확인” 액션만 active이고 나머지는 pending으로 오래 남아, 실제 검색 진행과 화면의 액션 상태가 어긋났다. 완료 기록은 후반 plan review에 몰아서 입력했다.

## 실행 비용과 로컬 어댑터

Steward는 일반 모델 라운드 24회 + 요약 4회 = provider 호출 28회, 도구 호출 46회, 약 15분을 사용했다. 생성 토큰 합계 52,032 중 요약이 27,362(52.6%)였다. 요약 출력은 각각 5079/6610/6921/8752 토큰으로, 이전 4096 제한을 넘어 정상적으로 이어졌다. 합산 입력 토큰은 1,124,457이며 반복 컨텍스트/캐시를 포함하므로 고유 텍스트 양이나 청구량으로 해석하면 안 된다.

`local/model-round.ts`는 여전히 stream:false이고 request.reasoningEffort를 전달하지 않는다. `local/text-protocol.ts`는 설정된 절대 출력 한도가 있을 때 상대 thinking budget을 계산하는 경로만 있다. 운영 요청의 reasoningEffort:none과 서버의 실제 추론 동작이 일치하지 않는다. Butler 마지막 응답은 생성 1900토큰, 추론 7109문자, 가시 답변 46문자였다. 이는 설정 전달 누락의 실증이며, 추론이 모든 실패의 원인이라는 증명은 아니다.

이번 범위의 provider 오류 로그는 발견하지 못했다. 부모 첫 라운드는 1064 생성 토큰 뒤 런타임이 빈 응답으로 판단하여 재요청했다. 마지막 라운드 raw만 저장되어 첫 응답의 finish_reason, content, reasoning, tool_calls를 복원할 수 없다. 따라서 그 빈 응답이 서버 파싱, 모델 출력, 어댑터 처리 중 어디서 발생했는지는 확정 불가하며 vLLM 버그라고 단정하지 않는다.

## 웹 도구와 근거 품질

web_read 19회 중 11회가 Page extraction failed였다. 실패 결과들은 lightpanda-unavailable-fell-back-to-lightweight, render_recommended:true를 반환했다. 이는 Qwen 고유 실패가 아니라 읽기 인프라의 제약이다. 성공 8회 중 하나는 26문자의 블로그 이름뿐이고 다른 하나는 뉴스 홈페이지였다. HTTP/도구 ok와 유효 기사 본문은 동일하지 않다.

산출물과 실제 도구 이력의 불일치:
- 해외 출처로 적은 mt.co.kr의 9월 9일 URL은 읽기 실패(#33)했는데 완료 검토에서는 본문 확인 완료로 주장했다. 실제 읽기 성공 URL은 다른 9월 8일 기사(#22)다.
- 발헤임은 ssalmuk 재전재 본문(#16)을 읽었지만 산출물은 inven URL을 달고 인벤 본문 확인 완료라고 주장했다. 해당 inven URL의 web_read는 없다.
- mt.co.kr을 “매일경제(MT)”로 표기했다. 출처 정체성도 혼동했다.

재전재를 읽었다고 그 원출처를 직접 검증한 것은 아니다. 같은 Qwen이 자기 결과를 accept한 검토만으로 이러한 불일치를 잡지 못했다. 뉴스 사실 자체의 진위는 이 조사에서 독립 검증하지 않았다.

## Butler 마무리 실패

`guided-turn-agent.ts:132` 부근은 성공한 child 결과를 받으면 부모 Work의 모든 액션을 done으로 처리한다. 실제로 최종 보고/작업 마감 액션까지 사용자 보고 전에 완료됐다. 이어 terminalParentSynthesis 경로에서 도구 표면을 제한했고, 실제 마지막 요청 tools는 []였다.

첫 응답은 비어 재요청됐다. 재요청 문구는 도구가 없는데도 “useful answer or tool call”을 요구했다. 기본 지시에는 도구 사용/Work 절차/보고 전에 기록할 작업 등이 다수 남아 있다. 이러한 조합은 최종 결과 전달만 해야 하는 순간의 역할 혼선을 유발할 수 있다. 다만 모델 내부 원인을 직접 증명하는 것은 아니다.

두 번째 provider 응답은 finish_reason:stop, tool call 없음, 예고문 46문자다. 시스템은 이 비어 있지 않은 문자열을 최종 답변으로 받아 실제 전송했다. 이는 전송 장애가 아니라 Qwen의 최종 응답 선택과 런타임의 완료 판정이 함께 만든 실패다.

## 우선순위와 후속 검증

1. **최종 전달 경로:** terminal parent synthesis에 실제 결과/산출물/한계와 “지금 결과를 전달할 것”을 일관되게 제공하고, 비어 있지 않은 예고문만으로 사용자 목표 완료를 인정하지 않도록 한다. parent 모든 액션 자동 완료 정책과 보고 액션의 의미를 함께 검토한다.
2. **진단 보존:** 라운드별 finish_reason, content/reasoning 길이, tool-call 수, 사용량, 요청 한도, HTTP 상태를 저장한다. 마지막 라운드만 보관해서 최초 빈 응답 근거가 사라지는 문제를 해결한다.
3. **로컬 설정 계약:** reasoningEffort:none을 vLLM이 지원하는 요청으로 실제 전달하고 비스트림/스트림을 같은 실패 입력으로 비교한다. 스트리밍 변경만으로 해결됐다고 주장하지 않는다.
4. **계획/활동:** 파일 효과가 있는 계획을 승인하기 전에 필요한 effect 누락을 피드백하고, 계획 수정에서는 최초 요청 접수 활동을 새로 만들지 않는다. 실제 액션 전환을 checkpoint에 반영한다.
5. **읽기/증거:** 본문 렌더 경로 가용성을 회복하고 제목만 반환한 ok를 본문 검증으로 취급하지 않는다. 최종 링크가 실제로 읽기 성공한 URL인지, 재전재인지 구분한다.

하나의 실행만으로 Qwen이 OpenAI보다 본질적으로 부적합하다고 일반화할 수 없다. 이 실행에서 확인된 것은 Qwen의 효과 필드 누락·출처 추적 오류·예고문 종결과, 공통 런타임의 표시/완료 판정·읽기 제약 및 로컬 어댑터 설정 누락이 결합했다는 점이다. 수정과 재실행은 수행하지 않았다.
