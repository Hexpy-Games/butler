import { PromptSuggestionList } from "@/butler-ds";
import { getAppLocale } from "@/app/copy.ts";
import { useEffect, useState } from "react";
import { api } from "@/app/api.ts";
import type { ActiveChatView, NewChatBriefingView } from "@/app/types.ts";
import { useButlerStore } from "@/app/store.ts";
import type { ButlerMarkTheme } from "@/butler-ds";
import butlerMarkDarkSrc from "@/assets/butler-mark-white.png";
import butlerMarkLightSrc from "@/assets/butler-mark.png";
import { activeChatWallpaper } from "./mainScreenTheme";
import { activeProjectId } from "./composerProjectContext";
import {
  generalFallbackSuggestions,
  projectFallbackSuggestions,
  skillFallbackSuggestions,
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
  const isSkillChat = activeChat.title.includes("스킬");
  const projectId = activeProjectId(navigation, activeChatId);
  const isProjectNewChat = Boolean(projectId) && !isSkillChat;
  const isGeneralNewChat = !projectId && !activeChat.project && !isSkillChat;
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

  const suggestions = isSkillChat
    ? skillFallbackSuggestions(activeChat.project)
    : isProjectNewChat
      ? (briefing?.suggestions ??
        projectFallbackSuggestions(activeChat.project))
      : (briefing?.suggestions ?? generalFallbackSuggestions());
  const description = briefing?.description;
  const titleIconSrc =
    markTheme === "dark" ? butlerMarkDarkSrc : butlerMarkLightSrc;
  const momentLabel = briefing?.moment ?? newChatMomentLabel();
  const wallpaper = activeChatWallpaper(settings, navigation, activeChatId);

  return (
    <PromptSuggestionList
      title={
        isGeneralNewChat || isProjectNewChat
          ? (briefing?.title ?? activeChat.title)
          : activeChat.title
      }
      description={description}
      wallpaper={wallpaper.source}
      wallpaperMotion={wallpaper.motion}
      wallpaperPauseOnBattery={wallpaper.pauseOnBattery}
      wallpaperTone={markTheme}
      moment={momentLabel}
      titleIcon={<img alt="" draggable={false} src={titleIconSrc} />}
      suggestions={suggestions.map((suggestion) => ({
        ...suggestion,
        disabled: isSending,
        onSelect: () => onSend(suggestion.text),
      }))}
    />
  );
}
