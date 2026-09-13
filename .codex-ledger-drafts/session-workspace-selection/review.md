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

## r2 교정 결과 — 캡슐형 선택
- 사용자가 지적한 설명문·제목·전체 폭 배경을 제거했다. DS NativeSelect의 내용 폭 pill 형태로 Monitor + Local 또는 GitBranch + Worktree만 표시한다. 화살표도 표시하지 않는다.
- 새 DS 블록 없이 기존 NativeSelect의 선택/키보드/터치 동작과 기본형 스타일을 유지한다. 사용하지 않는 설명 copy 3개도 삭제했다.
- 공용 컴포저 DOM 선택 테스트 1 pass / 19 expectations, UI typecheck, lint:design, 수정 파일 ESLint·CSS 검사, UI build, diff check 통과.
- DS Viewer의 실제 fixture에 기본형과 캡슐형을 연결했다. desktop 및 320/375/390/430px 렌더 모두 통과했고 desktop·320px 이미지를 직접 확인했다.
- 서버·전송 계약과 Local 기본값은 그대로다. 운영 재시작이나 배포는 하지 않았다.

## r3 교정 — 기존 컴포저 캡슐 재사용 (r2 시각 인수 취소)
- 기존 StewardComposerCapsules의 PillButton surface="glass"와 중앙 정렬을 직접 확인했다. r2 NativeSelect pill 외형은 요구한 기존 캡슐과 달랐으므로 관련 API·CSS·fixture 변경을 제거했다.
- DS SelectPillTrigger는 Radix Trigger asChild 아래에 실제 PillButton surface="glass"를 사용한다. 제품과 기존 진행 캡슐이 같은 스타일 소유자를 공유하며 새 캡슐 CSS는 없다.
- 공용 ComposerWorkspaceSelect에 중앙 정렬, 14px 아이콘과 선택값만 적용했다. 설명·제목·화살표는 없다.
- DOM 표시/상태/전송 잠금 검사 1 test / 14 expectations 통과. JSDOM의 portal 제한 때문에 메뉴 동작은 실제 브라우저에서 확인했다.
- 격리된 실제 UI의 대시보드 클릭 선택, 새 대화 Local 초기화, 키보드 선택이 통과했다. DS Viewer에서 기존 glass PillButton과 선택 트리거를 나란히 렌더링해 동일 외형을 확인했고 desktop/320/375/390/430px 렌더가 통과했다.
- UI typecheck, lint:design, 변경 파일 ESLint, build, diff check 통과. 서버·전송 동작 변경 없음. 운영 재시작·배포 없음.

## r4 — 왼쪽 정렬
- 공용 ComposerWorkspaceSelect의 Stack justify를 center에서 start로 변경했다. 대시보드와 새 대화 모두 컴포저 왼쪽에 정렬된다.
- 코드 diff를 요청과 대조했고 diff check를 통과했다. 기존 디자인과 선택 동작 변경은 없다.
