import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../Button";
import { Card } from "../Card";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { Presence, type PresenceMotion } from "./Presence";

export const meta: ShowcaseMeta = {
  title: "Presence",
  category: "Feedback",
  tags: ["motion", "enter", "exit", "mount", "animation"],
  status: "beta",
};

const labels = {
  "en-US": { show: "Show", hide: "Hide", body: "Enters with a fade and a small rise, exits faster." },
  "ko-KR": { show: "보이기", hide: "숨기기", body: "살짝 떠오르며 나타나고 더 빨리 사라집니다." },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

function PresenceDemo({ context, motion }: { context: ShowcaseRenderContext; motion: PresenceMotion }) {
  const [present, setPresent] = useState(true);
  return (
    <Stack gap="md">
      <Button
        variant="outline"
        text={present ? text(context).hide : text(context).show}
        onClick={() => setPresent((value) => !value)}
      />
      <Presence present={present} motion={motion}>
        <div>
          <Card>
            <Typo.Body>{text(context).body}</Typo.Body>
          </Card>
        </div>
      </Presence>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Rise", states: ["enter", "exit"], render: (context) => <PresenceDemo context={context} motion="rise" /> },
  { name: "Fade", states: ["enter", "exit"], render: (context) => <PresenceDemo context={context} motion="fade" /> },
];
