import type { ShowcaseMeta, ShowcaseStory } from "../../showcase";
import { StepListDemo } from "./StepSortableList.demo";

export const meta: ShowcaseMeta = {
  title: "StepSortableList",
  category: "Conversation & Activity",
  tags: ["list", "steps", "chain", "묶음", "reorder", "drag", "dnd-kit", "keyboard", "motion"],
  status: "beta",
};

// Shapes: "a!" a running head; "b+c" a 묶음; "?" held, "." done (StepSortableList.fixtures).
export const stories: ShowcaseStory[] = [
  // Drag a card or its grip: between steps = new step (accent line), rest on a step 250 ms = run together (ring).
  { name: "Single chain", states: ["drag"], widths: ["320", "375", "app"], render: (context) => <StepListDemo context={context} shape={[["a!", "b", "c", "d"]]} /> },
  { name: "Multiple chains", states: ["drag"], widths: ["375", "app"], render: (context) => <StepListDemo context={context} shape={[["a!", "b+c", "d"], ["e!", "f"]]} /> },
  // A collapsed 묶음 drags as one step; tap it to open its column (one indent, one step number), then drag a card out to split it.
  { name: "Step with a stack", states: ["drag", "open"], widths: ["320", "375", "app"], render: (context) => <StepListDemo context={context} shape={[["a!", "b+c+d", "e"]]} /> },
  { name: "Pinned running row", widths: ["375", "app"], render: (context) => <StepListDemo context={context} shape={[["a!", "b", "c"]]} /> },
  { name: "Held and done rows", widths: ["375", "app"], render: (context) => <StepListDemo context={context} shape={[["a.", "e!", "b?", "c?"]]} /> },
  // Static drag states: "Write the talk script" over the gap before step 1, and "Send the summary email" resting on step 2.
  {
    name: "Drag over a gap",
    states: ["drag"],
    widths: ["375", "app"],
    render: (context) => <StepListDemo context={context} shape={[["a!", "b", "d"], ["e!", "f"]]} preview={{ itemIds: ["d"], target: { chainId: "chain-0", stepIndex: 1, kind: "gap" } }} />,
  },
  {
    name: "Dwell on a step (join)",
    states: ["drag"],
    widths: ["375", "app"],
    render: (context) => <StepListDemo context={context} shape={[["a!", "b", "d"], ["e!", "f"]]} preview={{ itemIds: ["f"], target: { chainId: "chain-0", stepIndex: 2, kind: "join" } }} />,
  },
];
