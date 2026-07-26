export function phaseLabel(phase?: string): string {
  if (!phase) return "진행";
  if (phase.startsWith("conception")) return "구상";
  if (phase === "contract_review") return "구상 검토";
  if (phase === "planning") return "계획";
  if (phase === "planning_review") return "계획 검토";
  if (phase === "task_execution") return "실행";
  if (phase === "task_review") return "작업 리뷰";
  if (phase.startsWith("feedback_")) return "피드백 반영";
  if (phase === "consolidation") return "통합 점검";
  if (phase === "reporting") return "보고";
  return "진행";
}
