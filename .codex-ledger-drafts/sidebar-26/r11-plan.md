# R11 대화창 최소 너비와 우측 패널 확장

- 최신 승인: 우측 패널을 넓혀 메인 대화창을 모바일 최소 폭(320 CSS px)까지 줄일 수 있다.
- 원인: usePanelResize 및 UI 캐시가 우측 폭을 고정 520px에서 잘랐다.
- 구현: 실제 shell 내부 폭을 관찰하고, 열린 왼쪽 패널과 320px를 제외한 폭을
  우측 최대값으로 사용한다. 실제 표시 폭으로 pointer/keyboard/ARIA/CSS를 일치시킨다.
- 창 축소/왼쪽 토글은 표시 폭만 제한하고 저장된 선호 폭을 덮어쓰지 않는다.
  좁은 docked 창에서 공간이 부족하면 우측의 292px 하한보다 대화창 320px를
  우선한다. 왼쪽도 필요하면 창-320px 이내로 제한한다. 모바일 drawer는 기존 정책 유지.
- 태스크: geometry·캐시 테스트 → 공통 geometry/hook/두 shell 소비자 수정 → 실제
  드래그/키보드/창 변경/복원 검증 → 리뷰·main 반영. 운영 에이전트는 중단하지 않는다.

## 완료 리뷰

- 원본 선호 폭과 현재 표시 geometry를 분리했다. root content box의 ResizeObserver
  한 개가 창/프레임 변화만 측정하며 상태값을 덮어쓰지 않는다. 실제 표시 폭과
  핸들 위치·ARIA·드래그 시작값은 같은 계산 결과다. 캐시 schema 변경 없음.
- 시작 화면이 좁은 패널에서 잘린 것을 스크린샷으로 확인하여 workspace/conversation
  컨테이너 쿼리를 적용했다. 컴포저 320px 내 너비/모든 버튼 경계까지 실측했다.
- 단위 5개(20 expectations), pointer/keyboard/resize/reload 실제 UI smoke 및
  기존 sidebar 1440/800/390/320px smoke 통과. 모바일 drawer 390px main 유지.
- build/lint/typecheck 통과. DS render 명령 all 통과. PromptSuggestionList 독립
  fixture 캡처는 배경이 가려 시각적 합격 증거로 사용하지 않았으며 실제 제품
  320px/모바일 스크린샷을 기준으로 리뷰했다. 기존 design-source suite 34통과/11실패 유지.
- hooks shape의 경고 2개는 변경하지 않은 live-session 테스트 파일의 길이이며
  새 geometry hook(24줄)과 resize hook(149줄)의 경계 문제는 없다.
