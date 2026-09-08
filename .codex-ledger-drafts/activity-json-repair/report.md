# 실행 활동 저장 계약 복구 결과

## 원인

64dbc5c9의 다국어 활동 라벨 생성부가 title을 undefined로 덮거나 toolsSummary의
없는 target을 명시적 undefined로 넣었다. SQLite progress repository의 stableJson은
undefined를 거절한다. publishGroup의 비차단 catch 때문에 도구는 계속됐지만 해당
활동의 public_note는 저장되지 않았고 observer가 표시할 execution anchor가 없었다.
운영 해당 Turn은 계획 검토/결과 검토와 77개 도구 기록을 보존했지만 execution note는 0개였다.

## 수정 및 검증

- 모델 작성 title override는 번역 참조의 title 프로퍼티를 삭제한다.
- toolsSummary는 target이 있을 때만 포함한다. canonical JSON 정책은 불변이다.
- 변경 전 실제 SQLite 회귀 테스트에서 두 차례 `BTCC canonical JSON rejects undefined values`
  재현. 변경 후 accepted review→검색→checkpoint→읽기의 단계/제목/도구 소속이
  SQLite→Steward observer→실제 UI reducer까지 보존된다.
- 관련 테스트 38개/160 assertions 통과. lint/typecheck/diff 검사 통과.
- 격리 브라우저: 실제 생성부→SQLite→HTTP observer→제품 모달의 live polling 경로에서
  새로고침 없이 계획 검토→공식 자료 수집(검색 포함)→근거 대조 갱신 확인.
  `.tmp/activity-json/steward-execution.png` 직접 시각 검토 완료.
  모델 응답 대신 명시적 호출 fixture 사용; 실제 외부 모델 재실행을 주장하지 않는다.
- module-shape 감사의 기존 대형 projection/wake 파일 경고는 책임 검토 후 유지했다.
  이번 변경은 2개 기존 생성부의 optional JSON 필드 처리이며 새 런타임 계층은 없다.
- 과거 저장되지 않은 note는 근거 없이 재구성하지 않는다. 기존 결과/도구 기록은 유지한다.

## 완료 리뷰

스펙 1–3 구현/검증 완료. UI/권한/단계 전이/캐시/작업 실행과 canonical identity 변경 없음.
운영 활성 대화가 없는 것을 확인하고 main 반영 후 기존 native service 경로로 재시작한다.
다른 작업에서 생성한 memory-recovery 초안은 이번 변경에서 제외한다.
