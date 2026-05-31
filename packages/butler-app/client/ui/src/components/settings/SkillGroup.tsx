import type { SkillSummaryView } from "@/app/types.ts";
import { CardList, CardListItem, FileText, Sparkles, Typo } from "@/butler-ds";

export function SkillGroup({
  title,
  skills,
  maxVisibleRows,
}: {
  title: string;
  skills: SkillSummaryView[];
  maxVisibleRows?: number;
}) {
  return (
    <CardList
      title={title}
      maxVisibleRows={maxVisibleRows}
      empty={<Typo.Caption>등록된 스킬이 없습니다.</Typo.Caption>}
    >
      {skills.map((skill) => (
        <CardListItem
          key={`${skill.source}:${skill.project_id ?? "default"}:${skill.name}`}
          icon={skill.user_invocable ? <Sparkles /> : <FileText />}
          title={skill.name}
          description={skill.description || skill.file_path}
          meta={skill.source}
        />
      ))}
    </CardList>
  );
}
