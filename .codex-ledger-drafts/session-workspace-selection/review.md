# 새 대화 작업 위치 선택 — 구현 리뷰

## 결과
- 프로젝트 대시보드와 새 대화 컴포저 위에 공용 Local / Worktree 선택 UI를 연결했다. Local이 기본값이며 일반 대화는 Worktree 선택이 비활성이다.
- 선택값은 기존 draft store가 소유하고, 전송 시 snapshot → ComposerControls → sendMessage → HTTP 또는 Electron preload → POST /sessions로 전달된다.
- 서버는 workspace_mode가 worktree인 프로젝트 요청만 기존 provisioner를 호출한다. 생략/Local은 프로젝트 폴더를 사용한다. 기존 session binding과 분기·복구 로직은 수정하지 않았다.
- 대시보드 전송 fingerprint에 작업 위치를 포함해 선택을 바꾸면 이전 생성 세션으로 재시도하지 않는다.
- 화면 검토에서 발견한 모바일 본문 겹침은 기존 TintedGlass로 수정했다. 새로운 CSS·DS 블록·영구 설정은 없다.

## 검증
- 실제 임시 Git 저장소 + 공개 HTTP 생성/조회: local 기본값과 명시적 local은 worktree 목록을 변경하지 않고 project workspace를 표시한다. 명시적 worktree 생성·실패 rollback·재시작 및 stale binding 검증 포함 6 tests / 97 expectations 통과.
- 실제 UI store 전송(일반/프로젝트/대시보드), renderer adapter와 실제 preload 실행: 80 tests / 243 expectations 통과.
- DOM 선택/전송 중 잠금/새 draft 초기화/기존 대화 미노출 + submit 선택 전달/수락 초기화: 2 tests / 18 expectations 통과. 배경 교정 후 DOM 테스트 재통과.
- 기존 dashboard retry 검사: 1 test / 8 expectations 통과.
- 전체 typecheck, 전체 lint(기존 warnings 455, errors 0), lint:design, UI build, preload syntax, git diff --check 통과. 마지막 배경 교정 후 UI typecheck·lint:design·build 재통과.
- 필수 app-client-design 검사는 33 pass / 12 fail. 변경 전 HEAD를 별도 임시 디렉터리에 추출해 재실행한 결과도 동일하며 실패 집합 차이는 0이다. 기존 source-string 기대값/구조 검사 drift다.
- 격리된 서버의 기존 VisualHarness에서 대시보드·새 프로젝트 대화 전환, Local/Worktree 선택, 1280px 및 320/375/390/430px 화면을 확인했다. `.tmp/session-workspace-selection/`에 screenshot과 검사 로그가 있다. Harness fixture의 대시보드 API 오류와 예제 대화는 이 작업의 실제 운영 데이터 검증으로 간주하지 않는다.
- 모듈 리뷰: 기존 큰 request/store/copy 파일에는 필드와 분기만 추가했다. 선택 UI는 기존 컴포저 도메인과 DS primitives를 사용한다. 새 컴포넌트 40줄, 별도 상태 권위나 전달 전용 모듈 없음.

## 최종 계약 대조와 한계
두 진입점의 선택 UI, Local 기본값, 실제 생성 요청의 분기, 웹/Electron 전달, 기존 세션 위치 보존을 확인했다. 운영 서비스 재시작·배포·원격 push는 수행하지 않았다. 실제 provider Turn이나 패키징된 Electron 실행을 이번 UI 변경의 검증으로 주장하지 않는다.
