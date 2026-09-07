# #26 r5 실행 계획

의도: 7개 사용자 지적을 기존 shell·탐색 상태 경로에서 바로잡는다.
권위: UI-SIDEBAR-INFORMATION-ARCHITECTURE r5 §22, 최신 사용자 스크린샷.
공개 경로: AdaptiveShell→SpaceSidebar/WindowChromeLayer; live event→navigation reconciliation→spaceActivity.
금지: 새 polling, 모델 상태 추정, 불투명 배경으로 재질 대체, 임의 runtime 중단/이력 수정.

1. 완료 — 기존 창 토글·간격·더보기·재질·환경별 레이아웃 복원 및 화면 검사.
2. 완료 — 완료 상태 갱신 누락의 hook 경로 수정 및 이벤트 회귀 검사.
3. 완료 — 전체 7항목 리뷰/검사/빌드, main 병합·push, 운영 6개 서비스 online/health 및 재시작된 Electron 실제 화면 확인.

설계 리뷰: 스크롤 소유자는 하나, 창 토글 소유자도 하나다. 상태는 서버 navigation이 권위이며 기존 coalescing과 generation fence만 사용한다. 테스트와 화면 검증은 사용자 지적의 7개 결과에 한정한다.
