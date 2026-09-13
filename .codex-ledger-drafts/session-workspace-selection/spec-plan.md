# 새 대화 작업 위치 선택 — 2026-09-14

## 의도와 계약
- 최신 사용자 요청: 프로젝트 대시보드와 새 대화의 컴포저 위에서 Local / Worktree를 선택하며 기본값은 Local이다.
- 기존 대시보드의 대화 worktree 정보 제외 원칙은 유지한다. 이번 UI는 생성할 대화의 작업 위치 선택이다.
- UI draft가 선택값을 소유한다. 새 draft 활성화 및 대시보드 전송 수락 후 Local로 초기화한다. 전송 중 변경은 잠근다. 프로젝트 없는 일반 대화는 Local만 가능하다.
- 공개 경로: Composer → useComposerSubmit → sendMessage → POST /sessions (웹 또는 Electron preload) → 기존 session 생성 → Worktree를 명시한 프로젝트 요청만 기존 provisioner 호출 → session-view와 첫 Turn의 기존 workspace authority.
- 요청 workspace_mode는 local | worktree이며 생략하면 local이다. 잘못된 값과 프로젝트 없는 worktree 요청은 400이다. Worktree 생성 오류/rollback, Git 미설치·비저장소 동작은 기존 provisioner 계약을 유지한다.
- 대시보드 재시도 fingerprint에 선택값을 포함한다. 동일 전송만 기존 세션을 재사용한다.
- 기존 세션 바인딩, 분기 기능, 작업 디렉터리 복구, 실행 중 대화, 운영 재시작·배포는 범위 밖이다.

## 실행 태스크
1. 완료: 요청 계약·서버 기본값·공용 컴포저 선택 UI·웹/Electron 전달을 한 경로로 구현한다.
2. 완료: 실제 HTTP 세션 생성의 local/명시적 worktree, UI 선택·기본값·전송, preload 전달을 검증하고 실제 화면을 확인한다.
3. 완료: 전체 diff와 공개 호출 경로를 계약에 대조하고 관련 정적 검사·결과 기록·커밋을 완료한다.

## 구현 전 리뷰
새 영구 설정이나 별도 워크트리 관리자를 만들 필요가 없다. 기존 Composer notice 슬롯과 DS NativeSelect/Stack을 재사용한다. 기존 session binding이 영구 작업 위치 권위이며 선택값은 생성 요청에만 사용한다. 위 계약은 사용자 요청을 충족하며 기존 대화 위치 변경을 요구하지 않는다.

## 시각 리뷰 교정
모바일 대시보드의 스크롤 본문과 선택 UI 글자가 겹치는 것을 확인해 기존 TintedGlass 배경을 선택 영역에 적용한다. 새 CSS나 별도 DS 블록은 만들지 않는다.

## r2 — 사용자 시각 교정 (최신 계약)
- 설명 문장, 별도 작업 위치 제목, 전체 폭 배경을 제거한다.
- 컴포저 위에는 `{아이콘} {Local 또는 Worktree}`만 표시하는 내용 폭의 캡슐형 셀렉트를 둔다. Local은 Monitor, Worktree는 GitBranch 아이콘을 사용한다.
- DS NativeSelect에 icon과 pill 형태를 추가해 기존 네이티브 선택 동작을 유지한다. 기존 기본형 셀렉트의 모습은 유지한다.
- 실행: DS 형태와 컴포저 적용 → 기존 선택 테스트/모바일·데스크톱 렌더 검토 → 관련 검사와 교정 커밋.
- 구현 전 리뷰: 서버·전송·기본값 계약은 r1과 같고 표현만 수정한다. 추가 설명이나 별도 패널을 다시 넣지 않는다.
