# #26 검증·완성도 리뷰

## r5 창 레이아웃·완료 상태 보정

- 원인: scrollContent의 18px gap과 sticky padding 중복, 신호등 공간+스크롤 inset+brand padding 중복, 창 토글을 브랜드 옆으로 옮긴 이중 소유, SpaceSidebar의 불투명 덮개, 환경을 무시한 1023px overlay 분기, turn.state_changed/일반 session.updated의 navigation 갱신 누락이었다.
- 단일 window chrome 토글을 복원했다. Electron 열림/닫힘 실제 화면에서 신호등 오른쪽 좌표를 유지했다. 약 800px 실제 Electron 창에서도 sidebar와 workspace가 함께 도킹되며, 검증 후 창 크기를 복원했다.
- 실제 빌드 UI+격리 App HTTP/SQLite에서 1440/800/390/320px 검증 통과. 제목 영역→첫 아이템 간격 Favorites/Space 모두 8px; 더보기와 같은 깊이 세션 제목 x 차이 0px; sidebar/sticky surface에 불투명 덮개 없음; browser 800px부터 단일 push 및 세션 선택 시 닫힘. 스크린샷 `.tmp/sidebar-r5/browser-{width}.png`.
- 실제 HTTP 메시지→live event→실제 sidebar에서 작업 상태 표시 후 delivered 응답에 따라 스피너 DOM이 제거됐다. 페이지 reload/수동 navigation 갱신 없이 통과했다. 모델 의미 E2E가 아니라 deterministic responder를 사용한 UI 이벤트 통합 검사다. 운영 Electron에서도 실제 사용자의 완료 응답과 일반 채널 스피너 없음 확인.
- live-session hook/navigation 26 tests, 99 assertions 통과. 현재 일반 채널과 다른 활성 채널 두 경우를 검사했다. responsive 11 tests, 68 assertions 통과. 기존 main의 Lexical 전환 이후 남은 composer `const minRows = 1` 소스 문자열 검사 1개는 해당 없음으로 별도 기록하고 회귀 실행에서 제외했다. 전체 저장소 테스트 무오류를 주장하지 않는다.
- typecheck, lint(DS/CSS), UI build, diff whitespace 검사 통과. DS AdaptiveShell/SidebarShell/CollapsibleNavGroup/NavSection/ChromeFrame을 5개 viewport에서 총 25개 렌더링했다. fixture의 fixed drawer가 viewer 바깥으로 튀어나오지 않도록 fixture만 paint/layout contain 처리했다.
- 구조 리뷰: 창 토글 한 소유자, viewport 분류 공유, openSession에서 drawer 탐색 완료 처리, canonical navigation만 상태 권위로 유지했다. 새 polling/BTCC 상태/원본 데이터 보정은 없다. module audit의 기존 큰 테스트 파일 2개와 기존 SidebarShell barrel은 이번 런타임 경로 변경 대상이 아니며 별도 분리하지 않았다.
- 실기기 iOS Safari와 Windows/macOS 외 네이티브 창은 이번 검증 범위가 아니다.
- 운영 반영: 구현 `6282c650`을 main에 fast-forward 병합하고 origin/main으로 push했다. 2026-09-07 23:39 KST native supervisor 6개 서비스 online, `/health` 정상 확인. 초기 Electron 실행은 서버 준비 전 health 대기 제한에 걸려 종료됐으며 서버 준비 완료 후 재실행했다. 최종 독립 드라이버 PID 1700(PPID 1), Electron PID 1983. 재시작 후 실제 화면에서 원래 신호등 오른쪽 토글, 간격·재질·더보기 정렬, 일반 채널 완료/스피너 없음과 Gateway ready를 확인했다.

## r4 추가 보정 검증

- 고유 general 채널은 archive/PATCH/DELETE/permanent-delete 모두 409로 거절한다. 권한 종료 부수효과 이전에 같은 정책을 검사한다. 일반이라는 제목의 다른 대화는 보관 가능하다.
- 재시작 시 보관된 general만 복구한다. 기존 메시지와 생성 시각, 대화 식별자 보존을 테스트했다.
- 모바일 액션 세로 배치, 즐겨찾기 제목 아래 8px, 빈 설명의 아이콘 시작점 정렬, 단일 전체 스크롤, 탐색 헤더 sticky, 기존 fade를 적용했다. DS SidebarShell 슬롯과 CollapsibleNavGroup offset을 확장했다.
- 집중 검사 16 tests / 263 assertions, 일반 대화 보관 중 transport 검사 1 test 통과. typecheck, lint, UI build 및 DS 5개 viewport render 통과. 기존 app-client-design 실패 7건은 그대로이며 전체 저장소 green을 의미하지 않는다.
- 실제 제품 DOM에서 Chromium 320/390/430px 및 1440px의 배치와 스크롤 좌표를 검사했다. 최신 탭에서도 고정 동작을 확인했다. 트리 그룹 sticky top은 탐색 헤더 118px + fade 14px = 132px로 반영됐다.
- /tmp/butler-r4-mobile-top.png, /tmp/butler-r4-mobile-sticky.png, /tmp/butler-r4-desktop-top.png, /tmp/butler-r4-desktop-sticky.png를 직접 확인했다. 격리 서버의 샘플 대화로 UI를 검사했으며 실제 모델 또는 물리 iOS Safari 검증으로 주장하지 않는다.
- 완성도 리뷰: 여섯 요청은 동일 제품 경로에 반영됐다. 수동 스크롤 전환·별도 스크롤 컨테이너·모델 실행 변경은 없다. 운영 반영은 아래 추가 기록으로 확인한다.
- 운영: 80d4470a를 main에 fast-forward 병합·origin/main 푸시 후 UI build와 운영 재시작을 마쳤다. 6개 서비스 online, app health 성공. general은 archived=1에서 0으로 복구됐으며 생성 시각과 메시지 174개는 유지됐다. Electron 드라이버 PID 29588은 PPID 1로 재실행했다.

기준: UI-SIDEBAR-INFORMATION-ARCHITECTURE r3 및 2026-09-07 메시지 하단 아이콘 배치 추가 요청.
구현/리뷰는 직접 수행했다. 서브에이전트는 사용하지 않았다.

## 승인된 제품 경로

| 범위 | 구현과 관찰 결과 |
| --- | --- |
| 혼합 트리·그룹 | 기존 App SQLite/navigation 경로 확장. 그룹 생성·세션 드롭 그룹화·이동·reload 후 동일 ID와 배치 보존 확인 |
| 탐색·메뉴 | 전체/최신/진행중, 고정 즐겨찾기/일반/설정, 위치·시간·상태 슬롯, native sticky. 모바일 long-press 메뉴와 숨겨진 more 확인 |
| 소속 이동 | 실제 Electron에서 일반→프로젝트→일반 이동 후 모델의 pwd가 목적지 프로젝트/Butler Data로 변경. 이전 합의와 메시지 유지 |
| 인라인 참조 | 실제 native mouse drag로 문장 중간 삽입. Electron 전송 parts가 DB에 저장되고 링크 재표시. 실제 모델이 read_conversation_session으로 원문 표식을 조회 |
| 주제 분리 | 일반의 실제 답변 버튼에서 주제/프로젝트 생성, seed 표시, 원문 복귀, 새 대화에서 합의 기억 확인 |
| 스마트 그룹 | 실제 configured openai/gpt-6-astra가 두 보험 대화를 한 단어 보험 그룹으로 분류. 별도 3초 deadline/max-output cap 없음 |
| 하단 액션 | 복사→새 주제대화→새 프로젝트→작업시간→메시지 시간. 아이콘/툴팁, 별도 텍스트 줄 없음 |

## 실제 검증에서 발견해 닫은 누락

- Electron api/preload가 send/queue/update-queue에서 content_parts를 버리던 연결을 수정했다.
- native drag 시작 시 composer가 접히던 동작을 수정했다.
- start_topic_conversation의 reviewed persistent effect adapter를 연결했다. 재확인은 같은 App 예약 키를 사용한다.
- 대화 검색의 external/canonical ID와 App ID를 기존 binding으로 해석한다. canonical 답변은 같은 대화의 공개 TurnOutcome와 App turn_id로 연결한다. 무관한 최신 답변으로 대체하지 않는다.
- 이동용 신규 Git 작업 폴더의 소유 기록을 생성 전에 저장하고, 중단 복구의 안전 정리가 대화 실행 gate를 점유하지 않도록 했다.

## 검증

- 집중 서버/저장/참조/이동/분류/bridge/effect 검사: 90 tests, 366 assertions 통과 (최종 코드 재실행).
- 하단 메타데이터/아이콘 검사: 4 tests, 24 assertions 통과.
- 행별 projection/인스턴스 marker 검사: 2 tests, 11 assertions 통과.
- typecheck, lint(DS/CSS 포함), UI production build, git diff --check 통과.
- Chromium 320/390/430px 및 데스크톱, 라이트/다크 화면 확인. 실제 iOS Safari 실기기 검증은 수행하지 않았다.
- UI 테스트는 파일별 독립 실행했다. 전체를 한 프로세스로 합치면 기존 module mock 오염으로 결과가 왜곡된다.
- 기존 main에서도 재현되는 UI behavior 3건과 app-client-design source assertion 7건은 별도 기존 실패로 기록했다. 기존 BTCC fast-suite fixture의 종료 불능/Project Work parity 실패도 main에서 확인했으며 이 기능을 위해 BTCC 계약을 바꾸지 않았다. 따라서 전체 저장소 테스트가 모두 초록이라는 주장은 하지 않는다.

## 경로와 한계

실제 모델 검사에는 기존 설정 자격으로 실행한 격리 Electron 제품을 사용했다. 가짜 모델/수동 결과 주입이 아니다.
스마트 분류·주제/프로젝트·이동·참조 1차 실행: sidebar-organization-live-1788783498737-47d8cbea.
자연어 도구 재검증: sidebar-organization-live-1788786919108-d3ffaa97. 실제 모델의 start_topic_conversation 호출이 성공했고, 새 대화 ‘별빛노트 다음 협의’와 원본 합의/출처가 저장됐다. effect applied receipt와 started=false를 확인했다.
실행 자료는 운영 데이터와 분리된 임시 run 디렉터리에 보존했다. 종료된 이전 run의 재생성 가능한 설치 패키지만 공간 확보를 위해 삭제했다.

## main·운영 반영 완료

- 구현 커밋 `e2fbf03b32dbc6076574009fc83282b9ca79557b`를 main에 통합하고 origin/main으로 push했다. 커밋 훅의 lint/typecheck를 우회하지 않았다.
- 2026-09-07 22:22 KST 기존 native-supervisor 운영 서비스를 재시작했다. app-gateway, butler-main, watchdog, scheduler, sync-consumer, embed-server online 및 `/health` 정상 응답을 확인했다.
- Electron 개발 앱도 main checkout으로 재시작했다. 새 드라이버 PID 69659는 PPID 1이며 Electron PID 70025로 실행됐다. Codex 셸의 자식 수명에 종속되지 않는다.
- 운영 Electron의 실제 접근성 트리와 화면에서 혼합 트리, 즐겨찾기, 전체보기/최신/진행중 탭, 하단 설정을 확인했다. 기존 general 채널은 archived=1이므로 사용자 보관 상태를 임의 변경하지 않았다.
- 격리 E2E에서 새 주제 생성 후 원본 답변 복귀도 마지막으로 재확인했다. `/tmp/butler26-final-footer-success.png`, `/tmp/butler26-final-branch-success.png`에 화면 증거를 보존했다.
- 계획 P1–P8과 최신 하단 아이콘 요청의 구현·검증·main 반영·운영 재시작을 완료했다. 남은 플랫폼 확인은 위에 명시한 물리 iOS Safari이며, #164는 변경하지 않았다.
- 재시작 후 지연 점검에서 watchdog/scheduler 종료를 추가로 발견했다. watchdog 로그는 격리 E2E watchdog PID를 전역 singleton으로 간주해 스스로 종료했음을 보여준다. scheduler 종료 원인은 이 로그로 확정할 수 없다. 테스트 환경을 먼저 종료하고 기존 supervisor API로 두 서비스를 다시 시작했다(PID 99208/99206). 이 운영상 복구와 별개로 watchdog의 데이터 루트 간 singleton 격리 결함은 #26 기능 수정에 포함하지 않았다.
