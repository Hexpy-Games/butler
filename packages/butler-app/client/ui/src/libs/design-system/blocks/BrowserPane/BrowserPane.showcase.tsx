import type { ShowcaseMeta, ShowcaseStory } from "../../showcase";
import { BrowserDemo } from "./fixtures/BrowserDemo";
import { ConversationFrameDemo, StandaloneFrameDemo } from "./fixtures/ConversationFrame";

export const meta: ShowcaseMeta = {
  title: "BrowserPane",
  category: "Browser",
  tags: ["browser", "pane", "sheet", "tabs", "toolbar", "page card", "conversation", "standalone"],
  status: "beta",
};

/** The pane alone, at a pane's height. */
function Pane({ locale, placement }: { locale: "en-US" | "ko-KR"; placement: "conversation" | "standalone" }) {
  return (
    <div style={{ height: 560, display: "flex" }}>
      <BrowserDemo locale={locale} placement={placement} />
    </div>
  );
}

export const stories: ShowcaseStory[] = [
  {
    // The approved layout: chat left (400px), the pane right, Butler holding the tab.
    name: "Conversation frame at 1440",
    widths: ["app", "wide"],
    render: ({ locale }) => <ConversationFrameDemo locale={locale} width={1440} height={900} />,
  },
  {
    name: "Conversation frame at 1100 (sidebar collapsed)",
    widths: ["app", "wide"],
    render: ({ locale }) => <ConversationFrameDemo locale={locale} width={1100} height={800} sidebar="collapsed" />,
  },
  {
    name: "Standalone browser at 1440",
    widths: ["app", "wide"],
    render: ({ locale }) => <StandaloneFrameDemo locale={locale} width={1440} height={900} holder="none" band={null} pointer={false} agent={false} />,
  },
  { name: "Pane in a conversation", render: ({ locale }) => <Pane locale={locale} placement="conversation" /> },
  { name: "Pane in the standalone browser", render: ({ locale }) => <Pane locale={locale} placement="standalone" /> },
];
