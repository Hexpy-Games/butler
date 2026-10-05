import { useEffect, useState } from "react";
import { Box, KeyValueRow, PageContainer, ScrollArea, Stack, Tag, Typo } from "@/butler-ds";
import { Controls, QUIT_STATES, STARTUP_STATES, StateSwitch } from "./Controls";
import { I18N_KEYS, PAGE_COPY, WINDOW_COPY } from "./copy";
import { GifReview } from "./GifReview";
import { DEFAULT_STATE, stateFromQuery, stateToQuery, type LifecycleState, type PageWidth } from "./state";
import { WindowFrame } from "./WindowFrame";

const PAGE_MAX: Record<PageWidth, number | undefined> = { desktop: undefined, "768": 768, "375": 375 };
export const PREVIEW_COMMAND = "node packages/butler-app/client/ui/ds-site/proposals/lifecycle-windows/electron-preview.mjs";

/** "Proposals → Lifecycle windows": controls, both windows at real size, notes, i18n keys, installer GIF. */
export function LifecycleWindowsProposalPage() {
  const query = new URLSearchParams(location.search);
  const [state, setState] = useState<LifecycleState>(() => stateFromQuery(query));
  const [width, setWidth] = useState<PageWidth>(() => (["desktop", "768", "375"].includes(query.get("width") ?? "") ? query.get("width") as PageWidth : "desktop"));
  const [play, setPlay] = useState({ startup: 0, quit: 0 });
  const copy = PAGE_COPY[state.locale];
  const update = (patch: Partial<LifecycleState>) => setState((current) => ({ ...current, ...patch }));

  useEffect(() => {
    document.body.classList.remove("theme-light", "theme-dark");
    document.body.classList.add(`theme-${state.theme}`);
    document.documentElement.lang = state.locale === "ko-KR" ? "ko" : "en";
    history.replaceState(null, "", `?${new URLSearchParams({ proposal: "lifecycle-windows", width, ...stateToQuery(state) })}`);
  }, [state, width]);

  return (
    // body is overflow: hidden (tokens.css app shell), so the page owns its scroller. ScrollArea's
    // frame is 100% + its 10px scrollbar offset; the narrower column keeps the document at 100vw.
    <Stack gap="none" UNSAFE_style={{ height: "100dvh", width: "calc(100% - 10px)" }}>
          <ScrollArea fill dataTestClass="lifecycle-proposal-scroll">
            <Box surface="base">
            <Stack gap="none" cross="center">
              <Stack gap="none" UNSAFE_style={{ width: "100%", maxWidth: PAGE_MAX[width] }}>
                <Box paddingY="xl">
                  <PageContainer width="full">
                    <Stack gap="xl">
                      <Stack gap="sm">
                        <Typo.Caption>{copy.eyebrow}</Typo.Caption>
                        <Typo.H1>{copy.title}</Typo.H1>
                        <Typo.Body>{copy.intro}</Typo.Body>
                      </Stack>
                      <Controls state={state} width={width} update={update} setWidth={setWidth} />
                      <Stack align="row" wrap gap="xl" rowGap="xl">
                        <Stack gap="md" grow basis="0" minWidth="0">
                          <StateSwitch label={copy.startup} states={STARTUP_STATES} labels={copy.startupStates} value={state.startup}
                            onChange={(startup) => update({ startup })} playLabel={copy.play}
                            onPlay={() => setPlay((value) => ({ ...value, startup: value.startup + 1 }))} />
                          <WindowFrame kind="startup" state={state} title={copy.startup} playSignal={play.startup} />
                        </Stack>
                        <Stack gap="md" grow basis="0" minWidth="0">
                          <StateSwitch label={copy.quit} states={QUIT_STATES} labels={copy.quitStates} value={state.quit}
                            onChange={(quit) => update({ quit })} playLabel={copy.play}
                            onPlay={() => setPlay((value) => ({ ...value, quit: value.quit + 1 }))} />
                          <WindowFrame kind="quit" state={state} title={copy.quit} playSignal={play.quit} />
                        </Stack>
                      </Stack>
                      <Box surface="raised" border="hairline" radius="panel" padding="lg">
                        <Stack gap="sm">
                          <Typo.Label>{copy.realWindow}</Typo.Label>
                          <Typo.Code wrap="anywhere">{PREVIEW_COMMAND}</Typo.Code>
                          <Typo.Caption tone="secondary">{copy.realWindowBody}</Typo.Caption>
                        </Stack>
                      </Box>
                      <Stack gap="md">
                        <Typo.H2>{copy.notesTitle}</Typo.H2>
                        {(["box", "panel"] as const).map((variant) => (
                          <Box key={variant} surface="raised" border="hairline" radius="panel" padding="lg">
                            <Stack gap="sm">
                              <Stack align="row" gap="sm" cross="center">
                                <Typo.Label>{copy.surfaces[variant]}</Typo.Label>
                                {variant === DEFAULT_STATE.surface ? <Tag>{copy.recommended}</Tag> : null}
                              </Stack>
                              <Typo.Body>{copy.notes[variant]}</Typo.Body>
                            </Stack>
                          </Box>
                        ))}
                      </Stack>
                      <Stack gap="md">
                        <Typo.H2>{copy.rulesTitle}</Typo.H2>
                        <Stack gap="sm">
                          {copy.rules.map((rule) => <Typo.Body key={rule}>{rule}</Typo.Body>)}
                        </Stack>
                      </Stack>
                      <Stack gap="md">
                        <Typo.H2>{copy.keysTitle}</Typo.H2>
                        <Box surface="raised" border="hairline" radius="panel" padding="lg">
                          <Stack gap="sm">
                            {I18N_KEYS.map(([key, read]) => (
                              <KeyValueRow key={key} label={<Typo.Code wrap="anywhere">{key}</Typo.Code>} detailLayout="stack"
                                value={read(WINDOW_COPY["ko-KR"])} description={read(WINDOW_COPY["en-US"])} />
                            ))}
                          </Stack>
                        </Box>
                      </Stack>
                      <GifReview locale={state.locale} />
                    </Stack>
                  </PageContainer>
                </Box>
              </Stack>
            </Stack>
            </Box>
          </ScrollArea>
    </Stack>
  );
}
