import { PromptSuggestionList } from "@/butler-ds";
import { getAppLocale } from "@/app/copy.ts";
import { useEffect, useState } from "react";
import { api } from "@/app/api.ts";
import type { ActiveChatView, NewChatBriefingView } from "@/app/types.ts";
import { useButlerStore } from "@/app/store.ts";
import type { ButlerMarkTheme } from "@/butler-ds";
import butlerMarkDarkSrc from "@/assets/butler-mark-white.png";
import butlerMarkLightSrc from "@/assets/butler-mark.png";
import {
  mainScreenFluidEnabled,
  mainScreenFluidPalette,
  mainScreenFluidVariant,
} from "./mainScreenTheme";
import { activeProjectId } from "./composerProjectContext";
import {
  fillComposerWithTemplate,
  generalFallbackSuggestions,
  projectFallbackSuggestions,
} from "./emptyStateSuggestions";

interface EmptyStateProps {
  activeChat: ActiveChatView;
  isSending: boolean;
  markTheme: ButlerMarkTheme;
  onSend: (text: string) => void;
}

function newChatMomentLabel(): string {
  return new Intl.DateTimeFormat(getAppLocale(), {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date());
}

export function EmptyState({
  activeChat,
  isSending,
  markTheme,
  onSend,
}: EmptyStateProps) {
  const settings = useButlerStore((state) => state.settings);
  const navigation = useButlerStore((state) => state.navigation);
  const activeChatId = useButlerStore((state) => state.activeChatId);
  const projectId = activeProjectId(navigation, activeChatId);
  const isProjectNewChat = Boolean(projectId);
  const isGeneralNewChat = !projectId && !activeChat.project;
  const [briefing, setBriefing] = useState<NewChatBriefingView | null>(null);

  useEffect(() => {
    if (!isGeneralNewChat && !isProjectNewChat) {
      setBriefing(null);
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams();
    if (isProjectNewChat && projectId) params.set("project_id", projectId);
    const query = params.toString();
    api<NewChatBriefingView>(
      query ? `/new-chat-briefing?${query}` : "/new-chat-briefing",
    )
      .then((nextBriefing) => {
        if (!cancelled) setBriefing(nextBriefing);
      })
      .catch(() => {
        if (!cancelled) setBriefing(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isGeneralNewChat, isProjectNewChat, projectId, settings.language]);

  const suggestions = isProjectNewChat
    ? (briefing?.suggestions ?? projectFallbackSuggestions(activeChat.project))
    : (briefing?.suggestions ?? generalFallbackSuggestions());
  const description = briefing?.description;
  const titleIconSrc =
    markTheme === "dark" ? butlerMarkDarkSrc : butlerMarkLightSrc;
  const momentLabel = briefing?.moment ?? newChatMomentLabel();

  return (
    <PromptSuggestionList
      title={
        isGeneralNewChat || isProjectNewChat
          ? (briefing?.title ?? activeChat.title)
          : activeChat.title
      }
      description={description}
      fluidBackground={mainScreenFluidEnabled(settings)}
      fluidPalette={mainScreenFluidPalette(settings, markTheme)}
      fluidTone={markTheme}
      fluidVariant={mainScreenFluidVariant(settings)}
      moment={momentLabel}
      titleIcon={<img alt="" draggable={false} src={titleIconSrc} />}
      suggestions={suggestions.map(({ template, ...suggestion }) => ({
        ...suggestion,
        disabled: isSending,
        onSelect: () =>
          template
            ? fillComposerWithTemplate(suggestion.text)
            : onSend(suggestion.text),
      }))}
    />
  );
}
