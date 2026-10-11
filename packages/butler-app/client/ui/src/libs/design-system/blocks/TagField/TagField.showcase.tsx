import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { TagField } from "./TagField";

export const meta: ShowcaseMeta = {
  title: "TagField",
  category: "Settings & Forms",
  tags: ["tags", "chips", "autocomplete", "combobox", "library", "input"],
  status: "beta",
};

const COPY = {
  "en-US": {
    label: "Tags", placeholder: "Add tag", remove: (n: string) => `Remove ${n}`, create: (n: string) => `Create tag “${n}”`,
    value: ["jeju", "stays"], all: [["cafés", 14], ["camping", 3], ["car rental", 2], ["jeju", 9], ["stays", 6], ["itinerary", 4]] as const,
  },
  "ko-KR": {
    label: "태그", placeholder: "태그 추가", remove: (n: string) => `${n} 빼기`, create: (n: string) => `‘${n}’ 태그 만들기`,
    value: ["제주", "숙소"], all: [["카페", 14], ["캠핑", 3], ["카카오맵", 2], ["제주", 9], ["숙소", 6], ["일정", 4]] as const,
  },
} as const;

function Demo({ locale, start, empty }: ShowcaseRenderContext & { start?: boolean; empty?: boolean }) {
  const copy = COPY[locale];
  const [value, setValue] = useState<string[]>(empty ? [] : [...copy.value]);
  return (
    <TagField value={value} onChange={setValue} label={copy.label} placeholder={copy.placeholder} removeLabel={copy.remove}
      createLabel={copy.create} suggestions={copy.all.map(([name, count]) => ({ name, count }))} autoFocus={start} />
  );
}

export const stories: ShowcaseStory[] = [
  { name: "With tags (type to complete)", render: (context) => <Demo {...context} /> },
  { name: "Empty with placeholder", render: (context) => <Demo {...context} empty /> },
];
