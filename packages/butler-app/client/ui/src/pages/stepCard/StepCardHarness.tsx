import { useEffect, useRef, useState } from "react";
import { AdaptiveShell, AdaptiveShellSidebar, AdaptiveShellWorkspace, ConversationScroll, ConversationShell,
  MessageListSurface, MessageRow, Stack, Typo } from "@/butler-ds";
import { EMPTY_SETTINGS } from "@/app/constants";
import { setAppCopyLanguage } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { appShellTheme } from "@/app/utils";
import { usePortalThemeClasses } from "@/hooks/usePortalThemeClasses";
import { StewardParentProgress } from "@/components/conversation/StewardParentProgress";
import { useWorkBlockExpanded } from "@/components/conversation/workBlockExpansion";
import { stepCardFixture } from "./stepCardFixture";
import { StewardStepProgress } from "./StewardStepProgress";

export function StepCardHarness() {
  const params = new URLSearchParams(window.location.search);
  const [fixture] = useState(() => stepCardFixture(params.get("state") === "finished"));
  const [ready, setReady] = useState(false);
  const initialized = useRef(false);
  const [expanded, toggle] = useWorkBlockExpanded(fixture.view.session_id);
  const theme = params.get("theme") === "dark" ? "dark" : "light";
  const settings = { ...EMPTY_SETTINGS, language: "ko", appearance_theme: theme } as const;
  usePortalThemeClasses(settings);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    setAppCopyLanguage("ko");
    useButlerStore.setState({ settings, activeChatId: "step-card-parent",
      sessionViews: { [fixture.view.session_id]: fixture.view },
      refreshSessionObserver: async () => true, openSessionObserver: () => {} });
    if (params.get("expanded") === "1" && !expanded) toggle();
    setReady(true);
  });
  const pair = params.get("pair") === "1";
  const cards = pair ? ["main", "a", "b"] : [params.get("card") ?? "main"];
  const labels = { main: "main (현재)", a: "A · 머리 행", b: "B · 구분선 라벨" };
  return <AdaptiveShell leftOpen={false} rightOpen={false} theme={appShellTheme(settings)}>
    <AdaptiveShellSidebar open={false} />
    <AdaptiveShellWorkspace>
      <ConversationShell composerReserve={0}>
        <ConversationScroll masked={false}>
          <MessageListSurface>
            <MessageRow role="assistant">
              <Stack gap="lg" data-test-class="step-card-capture">
                {ready ? cards.map(card => <Stack gap="xs" key={card} data-step-card={card}>
                  {pair ? <Typo.Caption>{labels[card as keyof typeof labels]}</Typo.Caption> : null}
                  {card === "a" || card === "b"
                    ? <StewardStepProgress progress={fixture.progress} plan={fixture.plan} variant={card} fold={params.get("fold") === "1"} />
                    : <StewardParentProgress progress={fixture.progress} />}
                </Stack>) : null}
              </Stack>
            </MessageRow>
          </MessageListSurface>
        </ConversationScroll>
      </ConversationShell>
    </AdaptiveShellWorkspace>
  </AdaptiveShell>;
}
