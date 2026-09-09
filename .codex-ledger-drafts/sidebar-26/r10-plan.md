# R10 프로젝트 탐색 컨트롤

- 승인: 최신 사용자 요청. 원본 명세 r10이 이전 아이콘/별도 펼침 슬롯 규칙에 우선한다.
- 경로: SpaceRow → 프로젝트 대시보드 IconButton → store.openProjectDashboard → 기존 대시보드.
- 작업: (1) 프로젝트 표식/상시 대시보드와 공용 메뉴 슬롯 (2) 더보기 텍스트 위계
  (3) 4폭 실제 UI에서 위치/표시 전환/메뉴/펼침/대시보드 진입 검증 후 리뷰·반영.
- 기존 DS ButtonContainer/IconButton/NavRow 사용. 도메인 액션 조합은 space 안에
  유지하고 새 상태 저장소나 라우터는 만들지 않는다. 세션 메뉴와 운영 에이전트는 불변.
- 추가 사용자 피드백: 버튼 여백은 2px, hit target 30px/44px 유지. 스페이스와
  프로젝트 중심 정렬 및 데스크톱 이전 중심 간격 32px를 실측한다.

## 완료 리뷰

- SpaceRowActions가 기존 메뉴와 공개 store 대시보드 명령을 조합한다. 별도
  navigation/expanded 상태 없음. 프로젝트 행 클릭과 대시보드 클릭은 분리된다.
- 1440/800/390/320px 실제 빌드 UI smoke 통과: 2px 여백, 두 버튼 중심 정렬,
  30px/44px target, hover 메뉴/행 펼침/모바일 long-press, 대시보드 진입 확인.
- 더보기 텍스트의 text-secondary와 기존 들여쓰기 유지 검증. 실제 데스크톱/모바일
  스크린샷 검토. DS Icons fixture를 실제 registry에 연결하여 render all 통과.
- 빌드/타입 검사 통과. 아키텍처 shape 17파일 이슈 없음. 기존 design-source
  suite는 이전과 동일한 34통과/11실패(레거시 소스 기대)로 이번 범위에서 확대하지 않았다.
- 탭 R 추가 확인: 운영 Vite UI에서 외곽과 세 탭 모두 8px임을 실측했다.
  시각적 크기 변경 없이 단일 CSS 규칙으로 묶고 4폭 smoke에 token 동일성 검증을 추가한다.
