import type { ShowcaseGuidance } from "../../showcase";
import { Space } from "../Space";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { Separator } from "./Separator";

// #region recipe: Rows with separators between them
function UsageRows() {
  return (
    <Stack gap="none">
      {["Input tokens", "Output tokens"].map((name, index) => (
        <Stack gap="none" key={name}>
          {index > 0 ? <Separator space="md" /> : null}
          <Stack align="row" justify="between"><Typo.Body>{name}</Typo.Body><Typo.Body tone="secondary">1.2M</Typo.Body></Stack>
        </Stack>
      ))}
    </Stack>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A hairline (or spacing-only) divider, horizontal or vertical, with a token space around it.",
  whenToUse: ["Separate rows of a list that is not a card list", "Divide inline items vertically"],
  whenNotToUse: [
    { when: "Only vertical space is needed", use: "Space" },
    { when: "A list of cards", use: "CardList" },
  ],
  recipes: [{ name: "Rows with separators between them", description: "Render the separator before every row except the first.", render: () => <UsageRows /> }],
  doDont: [
    {
      do: { caption: "Separators between items, never above the first.", render: () => <UsageRows /> },
      dont: { caption: "A line used only for spacing adds noise; use Space.", render: () => <Stack gap="none"><Typo.Body>Profile</Typo.Body><Separator /><Space size="md" /><Typo.Body>Theme</Typo.Body></Stack> },
    },
  ],
  content: ["No copy of its own."],
  accessibility: ["Decorative by default (no role); pass decorative={false} only when it separates landmark content."],
  tokens: ["--line", "--line-strong", "--space-md"],
};
