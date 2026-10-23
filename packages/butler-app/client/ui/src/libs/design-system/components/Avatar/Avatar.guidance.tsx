import type { ShowcaseGuidance } from "../../showcase";
import { Bot, Notebook } from "../Icons";
import { IconSlot } from "../IconSlot";
import { Inline } from "../Inline";
import { Typo } from "../Typo";
import { Avatar } from "./Avatar";

// #region recipe: Assignee after a title
function AssigneeAfterTitle() {
  return (
    <Inline gap="xs" wrap={false}>
      <IconSlot size="sidebar"><Notebook /></IconSlot>
      <Typo.Text truncate>Visualization blocks</Typo.Text>
      <Avatar name="minji" tone="other" label="minji" />
    </Inline>
  );
}
// #endregion

// #region recipe: Agent working for the assignee
function AgentWorking() {
  return (
    <Inline gap="xs" wrap={false}>
      <Typo.Text truncate>Visualization blocks</Typo.Text>
      <Avatar name="Harin" label="Harin · Claude Code working" badge={<Bot />} />
    </Inline>
  );
}
// #endregion

// #region recipe: Name written beside the avatar
function NamedAssignee() {
  return (
    <Inline gap="xs" wrap={false}>
      <Avatar name="Harin" size="sm" decorative />
      <Typo.Text>Harin</Typo.Text>
      <Typo.Caption tone="secondary">· Claude Code working</Typo.Caption>
    </Inline>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A person's initial in a small circle: who an item is assigned to, with an optional corner mark while an agent works for them.",
  whenToUse: [
    "Show the assignee right after an item's title in a sidebar row, board card or list row",
    "Mark that an agent (Claude Code, Codex, Butler) is working on the item for that person",
    "Show the author of an activity or change row beside the name",
  ],
  whenNotToUse: [
    { when: "Who wrote a conversation message", use: "MessageAvatarBlock" },
    { when: "An agent, model or provider on its own", use: "ProviderLogo" },
    { when: "A count or a status word", use: "Tag" },
    { when: "Something new the user has not seen", use: "UnreadDot" },
  ],
  recipes: [
    { name: "Assignee after a title", description: "xs avatar right after the truncating title; the title gives way first.", render: () => <AssigneeAfterTitle /> },
    { name: "Agent working for the assignee", description: "The badge holds the agent's glyph; the label says who and which agent.", render: () => <AgentWorking /> },
    { name: "Name written beside the avatar", description: "Decorative when the name is already text next to it.", render: () => <NamedAssignee /> },
  ],
  doDont: [
    {
      do: { caption: "Right after the title, one avatar per item.", render: () => <AssigneeAfterTitle /> },
      dont: {
        caption: "Do not use an avatar as an agent's own icon; agents are a badge on the person.",
        render: () => (
          <Inline gap="xs" wrap={false}>
            <Typo.Text truncate>Visualization blocks</Typo.Text>
            <Avatar name="Claude Code" tone="other" />
          </Inline>
        ),
      },
    },
  ],
  content: [
    "People only: the name is a person's display name; Hangul names show the first syllable (하린 → 하), Latin names the first letter uppercased (minji → M).",
    "The label is product copy and doubles as the tooltip: \"하린 (나)\", \"minji 님\", \"하린 · Claude Code 작업 중\".",
    "tone self is the signed-in person; other is everyone else.",
  ],
  accessibility: [
    "role=\"img\" named by label (or name). Pass decorative when the name is written beside it, so it is not read twice.",
    "Inside a row with its own name, also put the label in the row's ariaDescription; the row's name hides the avatar.",
    "The badge is aria-hidden; say the agent in the label. It pops in and fades out; reduced motion makes it a plain fade.",
  ],
  tokens: [
    "--icon-size-md", "--icon-size-lg", "--icon-size-xl", "--icon-size-xs", "--icon-size-sm", "--radius-pill", "--line",
    "--text-secondary", "--accent", "--accent-text", "--color-surface-raised-opaque", "--text-primary", "--font-weight-semibold",
    "--border-hairline", "--motion-base", "--motion-exit-base", "--motion-ease-decelerate", "--motion-ease-accelerate", "--motion-scale-check",
  ],
};
