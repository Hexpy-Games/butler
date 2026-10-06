import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Briefcase, Sparkles } from "../Icons";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { GlyphToggle } from "./GlyphToggle";

export const meta: ShowcaseMeta = {
  title: "GlyphToggle",
  category: "Action",
  tags: ["pin", "favorite", "toggle", "sidebar", "glyph"],
  status: "beta",
};

const labels = {
  "en-US": { title: "Butler site", pin: "Pin", unpin: "Unpin" },
  "ko-KR": { title: "Butler 사이트", pin: "고정", unpin: "고정 해제" },
} as const;

function Row({ context, initial }: { context: ShowcaseRenderContext; initial: boolean }) {
  const [pinned, setPinned] = useState(initial);
  const copy = labels[context.locale];
  return (
    <Stack align="row" cross="center" gap="sm">
      <GlyphToggle glyph={<Briefcase />} toggleGlyph={<Sparkles fill={pinned ? "currentColor" : "none"} />} pressed={pinned}
        label={`${copy.title} ${pinned ? copy.unpin : copy.pin}`} onClick={() => setPinned((value) => !value)} />
      <Typo.Text truncate>{copy.title}</Typo.Text>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Pin toggle over a row glyph", states: ["hover", "focus-visible"], render: (context) => <Row context={context} initial={false} /> },
  { name: "Pinned", states: ["selected"], render: (context) => <Row context={context} initial /> },
];
