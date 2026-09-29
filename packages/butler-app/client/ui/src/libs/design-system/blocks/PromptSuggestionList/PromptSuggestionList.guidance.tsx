import type { ShowcaseGuidance } from "../../showcase";
import { Card } from "../../components/Card";
import { Typo } from "../../components/Typo";
import type { WallpaperSource } from "../Wallpaper";
import { PromptSuggestionList } from "./index";

// #region recipe: New chat suggestions
function NewChatSuggestions() {
  return (
    <PromptSuggestionList title="Where should we start today?" description="Pick a next step or type your own." suggestions={[
      { id: "review", title: "Review risky changes", description: "Find missed checks in recent work.", text: "Review the risky parts of recent changes" },
      { id: "plan", title: "Plan today", description: "Order open work into steps.", text: "Plan today's work in order" },
    ]} />
  );
}
// #endregion

// #region recipe: New chat over a wallpaper
// A stable source (module constant or memoized settings), never a new literal per render.
const NEW_CHAT_WALLPAPER: WallpaperSource = { kind: "live", module: "butler.bloom", params: { colors: "aurora" } };

function NewChatOverWallpaper() {
  return (
    <div style={{ position: "relative", height: 240, contain: "layout paint" }}>
      <PromptSuggestionList title="Where should we start today?" wallpaper={NEW_CHAT_WALLPAPER} suggestions={[
        { id: "plan", title: "Plan today", description: "Order open work into steps.", text: "Plan today's work in order" },
      ]} />
    </div>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The new-chat starter: a headline, prompt suggestions that fill the composer, and the optional wallpaper behind them.",
  whenToUse: ["An empty conversation that should offer next steps"],
  whenNotToUse: [
    { when: "Nothing to suggest", use: "EmptyLine" },
    { when: "A decorative translucent surface", use: "TintedGlass" },
  ],
  recipes: [
    { name: "New chat suggestions", description: "Each suggestion carries the prompt text that goes into the composer.", render: () => <NewChatSuggestions /> },
    { name: "New chat over a wallpaper", description: "Pass a WallpaperSource; the block draws it full-screen behind the prompt in the current theme.", render: () => <NewChatOverWallpaper /> },
  ],
  doDont: [
    {
      do: { caption: "Two to four concrete suggestions with a one-line description.", render: () => <NewChatSuggestions /> },
      dont: { caption: "Generic cards (Ask anything) that say nothing specific.", render: () => <Card><Typo.Body>Ask anything</Typo.Body></Card> },
    },
  ],
  content: ["Titles are actions (Plan today); the prompt text is what the user would type, in their language."],
  accessibility: ["Suggestions are buttons; the wallpaper is decorative (aria-hidden) and holds a still frame under reduced motion."],
  tokens: ["--typo-new-chat-title-size", "--typo-new-chat-title-size-md", "--radius-panel", "--motion-base"],
};
