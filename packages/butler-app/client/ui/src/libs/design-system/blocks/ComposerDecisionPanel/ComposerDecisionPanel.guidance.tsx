import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { Folder, ListChecks, Terminal } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Tag } from "../../components/Tag";
import { Typo } from "../../components/Typo";
import { LIVE_PAGES } from "../LiveTabCard/fixtures";
import { LiveTabFrame } from "../LiveTabCard/LiveTabFrame";
import { ComposerDecisionPanel } from "./ComposerDecisionPanel";

// #region recipe: Plan waiting for acceptance
function PlanDecision() {
  return (
    <ComposerDecisionPanel icon={<ListChecks aria-hidden="true" size="lg" />} eyebrow="Plan" title="Design system final cleanup plan" onOpen={() => undefined}
      actions={<ButtonContainer size="sm" justify="end">
        <Button size="sm" variant="secondary">Keep planning</Button>
        <Button size="sm">Accept plan</Button>
      </ButtonContainer>} />
  );
}
// #endregion

// #region recipe: Approval request with examples and risk
function ApprovalRequest() {
  return (
    <ComposerDecisionPanel icon={<Folder aria-hidden="true" size="lg" />} eyebrow="Permission" title="Edit 24 files in 'Desktop'?" onOpen={() => undefined}
      details={["Screenshot 10.02.14.png", "Screenshot 10.05.31.png", "Screenshot 10.09.02.png", "+21 more"]} literal
      aside={<Tag tone="warning">Medium risk</Tag>}
      actions={<ButtonContainer size="sm" justify="end">
        <Button size="sm" variant="secondary">Deny</Button>
        <Button size="sm">Allow once</Button>
      </ButtonContainer>} />
  );
}
// #endregion

// #region recipe: Command body in a code frame
function CommandBody() {
  return (
    <ComposerDecisionPanel icon={<Terminal aria-hidden="true" size="lg" />} eyebrow="Permission" title="Run a command in 'garden'?" onOpen={() => undefined}
      details={[{ code: "python3 -c '\nfor n in range(3):\n    if n:\n        print(n)\n'" }, "garden"]} literal
      aside={<Tag tone="danger">High risk</Tag>}
      actions={<ButtonContainer size="sm" justify="end">
        <Button size="sm" variant="secondary">Deny</Button>
        <Button size="sm">Allow once</Button>
      </ButtonContainer>} />
  );
}
// #endregion

// #region recipe: Browser approval with the page
function BrowserApproval() {
  return (
    <ComposerDecisionPanel icon={<Folder aria-hidden="true" size="lg" />} eyebrow="Permission" title="Click ‘Book now’" onOpen={() => undefined}
      details={["Pine Grove Campground · Oct 20 and 22, 2 nights"]} aside={<Tag tone="warning">Medium risk</Tag>}
      media={{ content: <LiveTabFrame frame={LIVE_PAGES.bookingApproval} />, label: "Open tab · Pine Grove Campground", onOpen: () => undefined }}
      actions={<ButtonContainer size="sm" justify="end">
        <Button size="sm" variant="secondary">Deny</Button>
        <Button size="sm">Allow once</Button>
      </ButtonContainer>} />
  );
}
// #endregion

// #region recipe: Approval in the conversation
function ConversationApproval() {
  return (
    <ComposerDecisionPanel placement="conversation" icon={<Folder aria-hidden="true" size="lg" />} eyebrow="Permission" title="Edit 24 files in 'Desktop'?" onOpen={() => undefined}
      details={["Screenshot 10.02.14.png", "+23 more"]} aside={<Tag tone="warning">Medium risk</Tag>}
      actions={<ButtonContainer size="sm" justify="end">
        <Button size="sm" variant="secondary">Deny</Button>
        <Button size="sm">Allow once</Button>
      </ButtonContainer>} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The composer's decision state: what is being decided, optional detail lines, an optional failure, and the decision buttons in the composer radius.",
  whenToUse: [
    "A plan waiting for acceptance or an authority request that replaces the composer input",
    "The same decision in the transcript, where it was asked (placement=\"conversation\")",
  ],
  whenNotToUse: [
    { when: "A notice inside the conversation", use: "Notice" },
    { when: "A modal confirmation", use: "Dialog" },
  ],
  recipes: [
    { name: "Plan waiting for acceptance", description: "Icon, clickable title, then a ButtonContainer justify=\"end\" of decisions.", render: () => <PlanDecision /> },
    { name: "Approval request with examples and risk", description: "A one-sentence question, up to three examples and a \"+N more\" line as details, a risk Tag in the aside; literal draws the exact characters.", render: () => <ApprovalRequest /> },
    { name: "Command body in a code frame", description: "A { code } detail: the markdown code frame look, the command's own spaces, indentation and line breaks in the code font; a long line scrolls sideways and a script taller than the details area scrolls inside the frame; each edge that hides content fades (useScrollEdges(\"both\")).", render: () => <CommandBody /> },
    { name: "Approval in the conversation", description: "placement=\"conversation\": its own flat Card radius=\"lg\", a 12px inset and control-radius buttons; no ComposerCard.", render: () => <ConversationApproval /> },
    { name: "Browser approval with the page", description: "media: the tab's 16:10 frame at the subject row's end; under 420px it spans the text column, cropped from the page's top to 140px. Clicking it opens the tab.", render: () => <BrowserApproval /> },
  ],
  doDont: [
    {
      do: { caption: "The panel owns the icon tone, title wrapping and button radius.", render: () => <PlanDecision /> },
      dont: { caption: "A hand-built row drifts from the composer padding and radius.", render: () => <Stack align="row" gap="sm" cross="center"><ListChecks size="lg" /><Typo.Label>Design system final cleanup plan</Typo.Label><Button size="sm">Accept plan</Button></Stack> },
    },
    {
      do: { caption: "Examples go in details: each wraps in full, aligned to the title.", render: () => <ApprovalRequest /> },
      dont: { caption: "Packing examples into the title wrappings them away.", render: () => <ComposerDecisionPanel icon={<Folder aria-hidden="true" size="lg" />} eyebrow="Permission" title="Edit 24 files in 'Desktop'? Screenshot 10.02.14.png, Screenshot 10.05.31.png, Screenshot 10.09.02.png and 21 more" onOpen={() => undefined} actions={<Button size="sm">Allow once</Button>} /> },
    },
  ],
  content: [
    "The title names the plan, or asks what the request will do: what, where and how many (Edit 24 files in 'Desktop'?).",
    "Details are short concrete items (file names, the command line), at most three, then \"+N more\".",
    "Details show exactly what is decided: never cut a command or path; pass the Show more/less labels so a long block clamps with the full text one click away.",
    "An approval passes literal: the title and details then draw their own characters (2876x6 stays x, -> stays two characters), never the body font's × or arrow.",
    "A command body (a script, a multi-line command) is a { code } detail: its spaces and line breaks stay real, so indentation reads as written and padding that pushes text sideways shows as horizontal scroll and the end fade, never as a collapsed paragraph.",
    "With renderText, a { code } detail arrives with as=\"code\": escape only deceptive characters (controls, bidi overrides, zero-width and non-standard spaces), never ordinary spaces, tabs or newlines.",
    "A complete reviewed input (memory text, schedule prompt, browser fields, MCP arguments) is a later detail line; the clamp keeps the first lines visible and Show more reveals the rest, never a silent cut.",
    "Paths in details are relative to the workspace, never absolute.",
    "Buttons are verbs (Accept plan, Deny, Allow once).",
    "media label names the target page (Open tab · Pine Grove Campground); a browser hand-off's primary action is 열어서 확인 / Open to check (butler-i18n browser.rail.openToCheck).",
  ],
  accessibility: ["The icon is decorative (aria-hidden); the title is a button that opens the source; details are plain text (a { code } detail is a left-to-right pre; when it scrolls it takes keyboard focus and draws its ring inset) and the Show more button carries aria-expanded and aria-controls; errors are announced with role=\"alert\"."],
  tokens: ["--adaptive-composer-radius", "--radius-control", "--radius-popover", "--space-xs", "--space-sm", "--space-md", "--space-lg", "--icon-size-sm", "--text-secondary", "--decision-media-narrow-height", "--line", "--radius-panel", "--surface-raised", "--typo-code-font", "--scroll-fade-size", "--focus-ring-width", "--focus-ring-color"],
};
