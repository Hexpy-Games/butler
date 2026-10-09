import type { ShowcaseGuidance } from "../../showcase";
import { ButtonContainer } from "../../components/ButtonContainer";
import { IconButton } from "../../components/IconButton";
import { ArrowLeft, ArrowRight, MoreHorizontal, RefreshCcw, TabIn } from "../../components/Icons";
import { Typo } from "../../components/Typo";
import { AddressField } from "../AddressField";
import { PageCard } from "../PageCard";
import { TabStrip } from "../TabStrip";
import { BrowserPane, BrowserToolbar } from "./BrowserPane";

// #region recipe: Browser pane in a conversation
function ConversationPane() {
  return (
    <div style={{ height: 360, display: "flex" }}>
      <BrowserPane label="Browser" placement="conversation"
        tabs={(
          <TabStrip hideChip groups={[{ id: "c1", kind: "conversation", label: "Office chair order", tabs: [{ id: "t1", title: "Office chairs" }] }]}
            activeTabId="t1" onActivate={() => undefined} onClose={() => undefined} onNewTab={() => undefined}
            trailing={<IconButton label="Bring in a tab"><TabIn size="md" /></IconButton>} />
        )}
        toolbar={(
          <BrowserToolbar
            navigation={(
              <ButtonContainer size="icon-sm">
                <IconButton label="Back"><ArrowLeft size="md" /></IconButton>
                <IconButton label="Forward" disabled><ArrowRight size="md" /></IconButton>
                <IconButton label="Reload"><RefreshCcw size="md" /></IconButton>
              </ButtonContainer>
            )}
            address={<AddressField url="https://shop.example.com/search?q=office-chair" onSubmit={() => undefined} onToggleBookmark={() => undefined} />}
            actions={<ButtonContainer size="icon-sm"><IconButton label="More"><MoreHorizontal size="md" /></IconButton></ButtonContainer>} />
        )}>
        <PageCard onBoundsChange={() => undefined} />
      </BrowserPane>
    </div>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The browser sheet: tab row, toolbar and the page card, inset on a tinted pane whose top corners match the card.",
  whenToUse: [
    "The browser beside a conversation (the AdaptiveShellSplit pane)",
    "The standalone Browser view under its title bar",
  ],
  whenNotToUse: [
    { when: "A preview of a Butler output inside the chat", use: "ArtifactPreview" },
    { when: "A page frame inside a dashboard or settings", use: "SurfacePanel" },
  ],
  recipes: [{ name: "Browser pane in a conversation", description: "TabStrip (hideChip + bring-in), BrowserToolbar with AddressField, PageCard.", render: () => <ConversationPane /> }],
  doDont: [
    {
      do: { caption: "Compose the rows from DS blocks; the pane owns the insets, the corner radius and the tint.", render: () => <ConversationPane /> },
      dont: { caption: "Glass over the page top: the page is a native view, so glass cannot blur it.", render: () => <Typo.Code>{"<TintedGlass><BrowserToolbar … /></TintedGlass>"}</Typo.Code> },
    },
  ],
  content: [
    "Labels come from butler-i18n browser.*: Browser / 브라우저 for the region; toolbar buttons name the action (Back, Reload).",
    "Korean copy says 버틀러; the bring-in button reads 내 탭 가져오기 / Bring in a tab.",
  ],
  accessibility: [
    "The pane is a labelled region; the toolbar row has role toolbar; tabs control the page card (TabStrip panelId = PageCard panelId).",
    "Every toolbar control is an IconButton with a label and tooltip.",
  ],
  tokens: ["--browser-pane-bg", "--browser-pane-radius", "--browser-card-inset", "--browser-band-height", "--menu-item-height"],
};
