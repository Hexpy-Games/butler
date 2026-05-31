import { Search, Terminal, Wrench } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { WorkActivityBlock } from "./WorkActivityBlock";

export function WorkActivityBlockFixture() {
  const tools = [
    {
      id: "search",
      icon: <Search size={15} />,
      title: "검색: gemma 연결 정보",
      summaryLabel: "검색",
      details: "환경 변수와 설정 파일을 읽어 연결 후보를 찾습니다.",
    },
    {
      id: "command",
      icon: <Terminal size={15} />,
      title: "Bash: env | grep -Ei \"CODEX|GEMMA\"",
      summaryLabel: "Bash",
      details: "명령 결과는 안전한 요약으로만 표시합니다.",
    },
    {
      id: "tool",
      icon: <Wrench size={15} />,
      title: "검증된 결과를 최종 응답에 반영",
      summaryLabel: "검토",
    },
  ];

  return (
    <Stack gap="lg">
      <WorkActivityBlock
        running
        title="로컬 명령으로 현재 상태를 확인합니다"
        description="확인 가능한 근거를 먼저 확보하고 결과를 다음 보고에 반영합니다."
        tools={tools}
      />
      <WorkActivityBlock
        title="확인한 결과를 답변에 반영합니다"
        description="완료된 뒤에도 배경 블록으로 바뀌지 않고 같은 타임라인 형태를 유지합니다."
        tools={tools.slice(0, 2)}
      />
    </Stack>
  );
}
