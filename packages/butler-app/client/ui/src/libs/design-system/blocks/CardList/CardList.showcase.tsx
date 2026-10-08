import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { FileText, Sparkles } from "../../components/Icons";
import { Typo } from "../../components/Typo";
import { CardList, CardListItem } from "./CardList";

export const meta: ShowcaseMeta = {
  title: "CardList",
  category: "Settings & Forms",
  tags: ["settings", "list", "skills", "mcp"],
  status: "stable",
};

const labels = {
  "en-US": {
    skills: "Project skills", noSkills: "No skills yet.", noMcp: "No MCP servers yet.", probe: "Test", enable: "Turn on", disable: "Turn off",
    enabled: "On", disabled: "Off", skillRows: [
      ["project-ledger", "Inspect, query, render, and validate project records.", "core", true],
      ["browser", "Open and inspect local web targets.", "user", false],
      ["butler-ship-feature", "Run Butler work through spec, task, review, and validation.", "core", true],
      ["butler-design-system", "Assemble UI only from the Butler design system.", "project", true],
    ],
  },
  "ko-KR": {
    skills: "프로젝트 스킬", noSkills: "아직 스킬이 없습니다.", noMcp: "아직 MCP 서버가 없습니다.", probe: "테스트", enable: "켜기", disable: "끄기",
    enabled: "켜짐", disabled: "꺼짐", skillRows: [
      ["project-ledger", "프로젝트 기록을 살펴보고 조회하고 검증합니다.", "core", true],
      ["browser", "로컬 웹 대상을 열어 살펴봅니다.", "user", false],
      ["butler-ship-feature", "명세, 작업, 검토, 검증 순서로 작업을 진행합니다.", "core", true],
      ["butler-design-system", "버틀러 디자인 시스템으로만 UI를 조립합니다.", "project", true],
    ],
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    // SkillGroup: capped rows; the list scrolls past maxVisibleRows.
    name: "Skills (max 3 rows)",
    widths: ["375", "app"],
    render: (context) => (
      <CardList title={text(context).skills} maxVisibleRows={3} empty={<Typo.Caption>{text(context).noSkills}</Typo.Caption>}>
        {text(context).skillRows.map(([name, description, source, invocable]) => (
          <CardListItem description={description} icon={invocable ? <Sparkles /> : <FileText />} key={name} meta={source} title={name} />
        ))}
      </CardList>
    ),
  },
  {
    // McpServerRow: toggle state as meta and compact actions.
    name: "MCP servers with actions",
    render: (context) => (
      <CardList>
        <CardListItem title="GitHub" description="stdio · npx @modelcontextprotocol/server-github" meta={text(context).enabled} selected
          actions={<ButtonContainer size="xs"><Button size="xs" variant="outline" text={text(context).probe} /><Button size="xs" variant="borderless" text={text(context).disable} /></ButtonContainer>} />
        <CardListItem title="Linear" description="http · https://mcp.linear.app/sse" meta={text(context).disabled}
          actions={<ButtonContainer size="xs"><Button size="xs" variant="borderless" text={text(context).enable} /></ButtonContainer>} />
      </CardList>
    ),
  },
  { name: "Empty", render: (context) => <CardList empty={<Typo.Caption>{text(context).noMcp}</Typo.Caption>}>{null}</CardList> },
];
