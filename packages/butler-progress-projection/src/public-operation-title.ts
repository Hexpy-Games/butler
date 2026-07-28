const PUBLIC_OPERATION_TITLES: Readonly<Record<string, string>> = {
  grep_files: "검색: 관련 구현을 찾는 중",
  list_files: "조회: 관련 파일 목록을 확인 중",
  project_ledger_read: "조회: 작업 원장을 확인 중",
  promote_reviewed_candidate: "적용: 검토된 변경을 반영 중",
  read_file: "조회: 관련 파일 내용을 확인 중",
  read_operation_result: "확인: 저장된 작업 결과를 검토 중",
  run_command: "실행: 계획한 작업을 처리 중",
  update_onboarding_profile: "설정: 온보딩 답변을 반영 중",
  web_read: "조회: 공개 자료를 확인 중",
  web_search: "검색: 공개 자료를 찾는 중",
  write_file: "작성: 계획한 파일 변경을 적용 중",
};

export function publicOperationTitle(capabilityRef?: string): string {
  const ref = capabilityRef?.trim();
  if (!ref) return "작업: 계획한 도구를 사용 중";
  return PUBLIC_OPERATION_TITLES[ref] ?? "작업: 계획한 도구를 사용 중";
}
