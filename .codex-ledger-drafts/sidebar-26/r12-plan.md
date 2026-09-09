# r12 목록 정리 토스트

1. 계약: footer 점유 제거, 중앙 Sonner 재사용, 8초 알림과 revision-bound undo 유지.
2. 구현: 중앙 알림 API에 action/duration/dismiss를 추가하고 space hook이 알림 수명을 소유.
   오류는 mutation 실패 경로에서 알리고 기존 폼 오류는 보존한다. 중앙 ko/en copy 사용.
3. 검증: 실제 UI에서 자동 정리 토스트, 중복 방지, undo HTTP 결과 및 수동 변경 알림,
   revision 무효화, 모바일 화면 경계/설정 footer 확인. lint/typecheck/build.
4. 완성도 리뷰 후 보고/커밋 및 main 반영. UI HMR 사용, 에이전트 재시작 없음.

설계 점검: 서버의 revision/undo 권위는 변경하지 않는다. 토스트는 투영과 기존 명령만
소유한다. token별 toast ID를 사용하고 이전 알림은 명시적으로 닫는다.
Sonner dismiss는 rAF로 전달되므로 같은 ID를 재사용하면 이전 닫기 이벤트가
새 알림까지 닫을 수 있다. token별 ID가 이전 알림과 새 알림의 수명을 분리한다.

완료: 코드/중앙 ko-en copy/알림 hook 및 shell 연결, 단위 검증, 실제 브라우저
1440/390 생성→토스트→HTTP undo, 시각 리뷰와 정적 검사. provider/백엔드 변경 없음.
