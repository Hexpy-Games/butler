import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
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
  useAppLocale();
  return (
    <CardList
      title={title}
      maxVisibleRows={maxVisibleRows}
      empty={<Typo.Caption>{appCopy.interfaceDetails.noSkills}</Typo.Caption>}
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
