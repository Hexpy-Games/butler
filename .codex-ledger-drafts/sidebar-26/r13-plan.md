# r13 진행 상태 말줄임

현재 결함: SpaceRowMeta의 statusText가 flex:none이라 긴 상태가 metadata 가용 폭보다
커지고 왼쪽 소속을 밀어낸다. NavRow meta 슬롯의 너비 제약 자체는 이미 올바르다.

1. 승인 계약: spec r13. 실제 navigation → SpaceRow → SpaceRowMeta → NavRow meta 경로만 수정.
2. 구현: 상태 문구와 n/k를 분리. 상태 컨테이너 max-width:60%, min-width:0,
   문구 overflow:hidden/text-overflow:ellipsis/nowrap, n/k flex:none. 경로도 min-width:0.
3. 검증: 격리 HTTP의 긴 경로/한영 상태 fixture를 실제 제품 UI로 표시. 320/390/1440px에서
   행 경계, 한 줄 ellipsis, 보이는 진척도, 전체 title, 최신 시간 정렬을 확인하고 시각 리뷰.
4. lint/typecheck 및 diff 리뷰, main 커밋/반영. UI 전용 변경으로 실행 중 에이전트 재시작 없음.

추가 승인: 수동 정리 성공 토스트 제거. useOrganizationNotice가 현재 revision의
smartNotice만 읽고 수동 undoToken fallback/구독을 제거한다. 자동 정리 안내/되돌리기,
중복 억제와 revision 무효화, 오류 알림을 보존한다. 기존 hook/브라우저 테스트를 갱신한다.

비목표: 상태 생성/번역/저장, 제목 줄 수, 버튼 크기, 별도 레이아웃 프레임워크 변경 없음.

## 완료 리뷰

- 실제 SpaceRowMeta/기존 DS NavRow에서 최대 60%와 말줄임 적용. 320/390/1440px ×
  한영 긴 상태 6경우에 행 경계, 전체 title, 진척도/소속 가시성, 최신 시간 정렬 통과.
  `.tmp/sidebar-overflow/` 모바일/데스크톱 캡처를 직접 검토했다.
- 알림은 서버 smartNotice만 소비한다. 수동 토큰 구독과 성공 copy를 제거했고,
  기존 오류 처리와 자동 정리의 revision-bound undo 권위는 그대로다.
- hook 테스트: 1개/13 assertions, 자동 알림/중복 억제/수동 변경 무알림/후속 자동 알림.
  실제 브라우저 1440/390px: 수동 생성 무알림, 자동 알림 fixture→Sonner→실제 HTTP undo 통과.
  알림 테스트는 자동 분류 모델을 호출하지 않고 HTTP의 smartNotice 출처만 fixture로 주입한다.
- lint/typecheck/UI build/diff 검사 통과. 코드 책임/실제 사용 경로와 승인 계약을 비교했다.
  서비스 코드 변경 없이 UI dist와 기존 Vite HMR 경로에 반영한다.
