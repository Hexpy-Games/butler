# R8 작은 원형 배경과 기존 클릭 영역

- 최신 사용자 요청이 r7의 직사각형 배경 규칙을 대체한다.
- 범위: 기존 SpaceSidebar → DS IconButton. 상태/메뉴/탭 배치와 버튼 hit box는 불변.
- 구현: DS IconButton의 hover/selected 배경을 CSS surface 변수로 표현하고,
  사이드바에서 중앙 24px(모바일 28px) 원형 gradient를 지정한다. 새 DOM/이벤트 없음.
- 태스크: 명세 확인 → CSS 적용 → 실제 UI에서 배경 크기와 투명 가장자리 클릭
  검증 → 리뷰/빌드/반영. UI만 변경하며 운영 에이전트 작업은 중단하지 않는다.
- 검증: 기존 4폭 sidebar smoke에 배경 크기/중앙 정렬과 가장자리 클릭 추가.
  배경은 hit box보다 작고, 가장자리 클릭도 실제 메뉴를 열어야 한다.

## 완료 리뷰

- 기존 버튼/이벤트를 그대로 사용하고 paint만 바꿨다. 별도 DOM이나 pointer
  영역을 만들지 않았으며, 다른 화면의 IconButton은 기본 배경을 유지한다.
- 실제 빌드 UI 1440/800/390/320px에서 30px/44px hit box 유지,
  24px/28px 중앙 원형 배경, 원 바깥 측면 클릭→메뉴 열림을 확인했다.
  기존 sticky/행 정렬/모바일 메뉴 정책 회귀도 통과했다.
- UI build, CSS lint, diff 검사 통과. DS render 명령은 통과했으나 기존
  IconButton fixture가 빈 컨테이너이므로 시각 증거는 실제 sidebar smoke를 사용했다.
- 광범위 design-source suite는 34통과/11실패: 기존 레이아웃/하드코딩 라벨 등의
  소스 문자열 기대가 현재 main과 맞지 않는 범위이며 이번 CSS 보정으로 고치지 않았다.
