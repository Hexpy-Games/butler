import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../Button";
import { Tag } from "../Tag";
import { Typo } from "../Typo";
import { Stack } from "./Stack";

// #region recipe: Title row with a trailing action
function TitleRow() {
  return (
    <Stack align="row" cross="center" justify="between" gap="md">
      <Stack.Item grow minWidth="0">
        <Typo.PanelTitle truncate>Provider usage and remaining quota for this month</Typo.PanelTitle>
      </Stack.Item>
      <Button size="sm" variant="outline" text="Details" />
    </Stack>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "One-dimensional layout (column or row) with token gaps and item props instead of CSS.",
  whenToUse: ["Stack content vertically with a named gap", "Lay out a row that grows, wraps or truncates"],
  whenNotToUse: [
    { when: "Two-dimensional layouts with columns", use: "Grid" },
    { when: "A wrapping row of chips or metadata", use: "Inline" },
    { when: "Adjacent buttons", use: "ButtonContainer" },
    { when: "Padding, surface or border around content", use: "Box" },
  ],
  recipes: [{ name: "Title row with a trailing action", description: "Stack.Item grow + minWidth=\"0\" lets the title truncate before the action.", render: () => <TitleRow /> }],
  doDont: [
    {
      do: { caption: "Named gaps (xs…2xl) keep rhythm across screens.", render: () => <Stack gap="sm"><Tag>One</Tag><Tag>Two</Tag></Stack> },
      dont: {
        caption: "Spacing by style or margins drifts and breaks the lint.",
        render: () => <div style={{ display: "flex", flexDirection: "column", gap: 13 }}><Tag>One</Tag><Tag>Two</Tag></div>,
      },
    },
  ],
  content: ["inline lays out an inline-flex run; as=\"ul\"/\"ol\" drops list chrome; windowDrag=\"drag\" | \"no-drag\" marks desktop titlebar regions; UNSAFE_style takes data-driven geometry only (allowlisted per file).", "No copy of its own."],
  accessibility: ["as=\"ul\" / \"nav\" / \"section\" gives lists and regions their semantics."],
  tokens: ["--space-xs", "--space-sm", "--space-md", "--space-lg", "--layout-basis-md"],
};
