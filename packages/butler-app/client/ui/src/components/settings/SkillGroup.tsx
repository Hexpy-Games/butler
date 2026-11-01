import { useAppLocale } from "@/app/copy.ts";
import type { SkillSummaryView } from "@/app/types.ts";
import { CardList, CardListItem, FileText, Sparkles } from "@/butler-ds";

/** A skills list in its section card; the section owns the title and the empty state. */
export function SkillGroup({
  skills,
  maxVisibleRows,
}: {
  skills: SkillSummaryView[];
  maxVisibleRows?: number;
}) {
  useAppLocale();
  return (
    <CardList maxVisibleRows={maxVisibleRows}>
      {skills.map((skill) => (
        <CardListItem
          key={`${skill.source}:${skill.project_id ?? "default"}:${skill.name}`}
          icon={skill.user_invocable ? <Sparkles /> : <FileText />}
          title={skill.name}
          description={skill.description || skill.file_path}
        />
      ))}
    </CardList>
  );
}
