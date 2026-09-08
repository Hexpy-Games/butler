# 실행 활동 이벤트의 다국어 JSON 계약 복구

Revision: 2026-09-08-r1
Parent: SPEC-BTCC-R3-SEMANTIC-ACTIVITY-PROJECTION

## 의도 및 근거

사용자 보고: 스튜어드 상태표시줄은 검색 중인데 활동내역은 계획 검토에서 멈춘다.
운영의 해당 Turn에는 계획 검토 뒤 77개 도구 기록이 있으나 실행 단계 public_note는
저장되지 않았다. 다국어 변경 64dbc5c9 이후 activity title override의 명시적 undefined,
toolsSummary의 없는 target: undefined가 canonical JSON 저장 계약과 충돌한다.
publishGroup은 관찰 오류가 도구 작업을 중단하지 않도록 삼키므로 도구는 계속 수행된다.

## 계약

기존 경로: guided activity → projectTurnProgressToEvents → SQLite progress outbox →
Steward observer → shared rows → UI projectTurnActivity. 다른 투영 우회로를 만들지 않는다.

- 활동의 모델 작성 제목으로 대체하면 번역 title reference는 프로퍼티 자체를 제거한다.
- 대상 없는 도구는 toolsSummary에 name만 넣는다. 명시적 undefined는 이벤트에 넣지 않는다.
- 원문 제목/설명, activity ID, stage, 도구의 소속은 보존한다.
- 저장소 JSON 엄격성, 실행 권한, 모델 프롬프트/캐시/단계 전이/재시도는 변경하지 않는다.
- 단순 callback 배열 테스트가 아니라 실제 SQLite 저장과 UI reducer까지 검증한다.
- 과거 저장되지 않은 이벤트를 임의의 문구나 시각으로 합성하지 않는다.

## 실행 및 검증 계획

1. 실제 저장소를 연결한 회귀 테스트로 execution/checkpoint 누락 재현.
2. 두 생성부에서 optional 필드를 생략하도록 최소 수정.
3. 저장→observer→UI에서 계획 검토 이후 실행/체크포인트와 도구 소속 확인.
   기존 staged projection tests, lint/typecheck, 실제 브라우저 UI 확인.
4. diff/스펙 리뷰 후 main 반영 및 정상 운영 시작 경로로 반영.

설계 리뷰: 원인은 직렬화 전에 발생하므로 UI에서 실행을 추측해 덧붙이지 않는다.
빈 필드 제거는 표시 의미를 바꾸지 않으며 canonical identity 계약을 약화하지 않는다.
