import type { ShowcaseMeta, ShowcaseStory } from "../../showcase";
import { SortableCardListFixture } from "./SortableCardList.fixtures";

export const meta: ShowcaseMeta = {
  title: "SortableCardList",
  category: "Settings & Forms",
  tags: ["list", "reorder", "drag", "dnd-kit", "motion"],
  status: "stable",
};

export const stories: ShowcaseStory[] = [
  {
    // Drag a grip: the card lifts (--motion-scale-lift, --shadow-drag-lift,
    // spring) and its neighbors slide aside on --motion-base.
    name: "Reorder with lift",
    states: ["drag"],
    render: () => <SortableCardListFixture />,
  },
];
