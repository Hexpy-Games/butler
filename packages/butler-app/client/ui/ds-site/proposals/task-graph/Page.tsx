import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Box, NativeSelect, NativeSelectOption, PageContainer, ScrollArea, SegmentedControl, Stack, Tag, Typo } from "@/butler-ds";
import { PAGE_COPY, type Scenario, type Variant } from "./copy";
import { FINDINGS } from "./findings";
import { DEFAULT_STATE, SCENARIOS, STAGE_MESSAGE, STAGE_SIZE, stateFromQuery, stateToQuery, type StageState, type StageWidth } from "./state";

function Control({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack gap="xs">
      <Typo.Label>{label}</Typo.Label>
      {children}
    </Stack>
  );
}

function useAvailableWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    observer.observe(node);
    setWidth(node.clientWidth);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** "Proposals → Task graph": controls, the width-true preview frame, variants and findings. */
export function TaskGraphProposalPage() {
  const query = new URLSearchParams(location.search);
  const [state, setState] = useState<StageState>(() => stateFromQuery(query));
  const [width, setWidth] = useState<StageWidth>(() => (["desktop", "768", "375"].includes(query.get("width") ?? "") ? query.get("width") as StageWidth : "desktop"));
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [measureRef, available] = useAvailableWidth();
  const copy = PAGE_COPY[state.locale];
  const findings = FINDINGS[state.locale];
  const update = (patch: Partial<StageState>) => setState((current) => ({ ...current, ...patch }));
  // The frame loads once; later changes are posted in so the clock and selection keep running.
  const initialSrc = useMemo(() => `?${new URLSearchParams({ proposal: "task-graph", stage: "1", ...Object.fromEntries(stateToQuery(state)) })}`, []);

  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage({ type: STAGE_MESSAGE, state }, location.origin);
    document.body.classList.remove("theme-light", "theme-dark");
    document.body.classList.add(`theme-${state.theme}`);
    document.documentElement.lang = state.locale === "ko-KR" ? "ko" : "en";
    history.replaceState(null, "", `?${new URLSearchParams({ proposal: "task-graph", width, ...Object.fromEntries(stateToQuery(state)) })}`);
  }, [state, width]);

  const size = STAGE_SIZE[width];
  const scale = available > 0 ? Math.min(1, available / size.width) : 1;
  const option = <T extends string>(values: Record<T, string>) => (Object.keys(values) as T[]).map((value) => ({ value, label: values[value] }));

  return (
    // body is overflow: hidden (app shell); the page owns its scroll region.
    <Stack gap="none" UNSAFE_style={{ height: "100dvh" }} data-test-class="task-graph-proposal-page">
      <ScrollArea fill dataTestClass="task-graph-proposal-scroll">
        <Box surface="base" paddingY="xl">
          <PageContainer width="full">
            <Stack gap="xl">
              <Stack gap="sm">
                <Typo.Caption>{copy.eyebrow}</Typo.Caption>
                <Typo.H1>{copy.title}</Typo.H1>
                <Typo.Body>{copy.intro}</Typo.Body>
              </Stack>

              <Box surface="raised" border="hairline" radius="panel" padding="lg">
                <Stack align="row" wrap gap="lg" rowGap="md">
                  <Control label={copy.scenario}>
                    <NativeSelect aria-label={copy.scenario} value={state.scenario} onChange={(event) => update({ scenario: event.target.value as Scenario })}>
                      {SCENARIOS.map((value) => <NativeSelectOption key={value} value={value}>{copy.scenarios[value]}</NativeSelectOption>)}
                    </NativeSelect>
                  </Control>
                  <Control label={copy.variant}>
                    <SegmentedControl ariaLabel={copy.variant} size="sm" value={state.variant} options={option(copy.variants)} onValueChange={(value) => update({ variant: value as Variant })} />
                  </Control>
                  <Control label={copy.width}>
                    <SegmentedControl ariaLabel={copy.width} size="sm" value={width} options={option(copy.widths)} onValueChange={(value) => setWidth(value as StageWidth)} />
                  </Control>
                  <Control label={copy.theme}>
                    <SegmentedControl ariaLabel={copy.theme} size="sm" value={state.theme} options={option(copy.themes)} onValueChange={(value) => update({ theme: value as StageState["theme"] })} />
                  </Control>
                  <Control label={copy.wallpaper}>
                    <SegmentedControl ariaLabel={copy.wallpaper} size="sm" value={state.wallpaper} options={option(copy.wallpapers)} onValueChange={(value) => update({ wallpaper: value as StageState["wallpaper"] })} />
                  </Control>
                  <Control label={copy.motion}>
                    <SegmentedControl ariaLabel={copy.motion} size="sm" value={state.motion} options={option(copy.motions)} onValueChange={(value) => update({ motion: value as StageState["motion"] })} />
                  </Control>
                  <Control label={copy.language}>
                    <SegmentedControl ariaLabel={copy.language} size="sm" value={state.locale}
                      options={[{ value: "ko-KR", label: "한국어" }, { value: "en-US", label: "English" }]}
                      onValueChange={(value) => update({ locale: value as StageState["locale"] })} />
                  </Control>
                </Stack>
              </Box>

              <div ref={measureRef}>
                <Stack cross="center" gap="none" UNSAFE_style={{ height: size.height * scale }}>
                  <Box border="hairline" surface="base">
                    <Stack gap="none" UNSAFE_style={{ width: size.width * scale, height: size.height * scale }}>
                      <Stack gap="none" UNSAFE_style={{ width: size.width, height: size.height, transform: `translate(${(size.width * (scale - 1)) / 2}px, ${(size.height * (scale - 1)) / 2}px) scale(${scale})` }}>
                        <iframe ref={frameRef} title={copy.frameLabel} src={initialSrc} width={size.width} height={size.height} frameBorder={0} />
                      </Stack>
                    </Stack>
                  </Box>
                </Stack>
              </div>

              <Stack gap="md">
                <Typo.H2>{copy.notesTitle}</Typo.H2>
                {(["open", "select"] as const).map((variant) => (
                  <Box key={variant} surface="raised" border="hairline" radius="panel" padding="lg">
                    <Stack gap="sm">
                      <Stack align="row" gap="sm" cross="center">
                        <Typo.Label>{copy.variants[variant]}</Typo.Label>
                        {variant === DEFAULT_STATE.variant ? <Tag>{copy.recommended}</Tag> : null}
                      </Stack>
                      <Typo.Body>{copy.notes[variant]}</Typo.Body>
                    </Stack>
                  </Box>
                ))}
              </Stack>

              {findings.map((group) => (
                <Stack key={group.title} gap="md">
                  <Typo.H2>{group.title}</Typo.H2>
                  <Box surface="raised" border="hairline" radius="panel" padding="lg">
                    <Stack as="ul" gap="sm">
                      {group.items.map((item) => <Stack as="li" key={item} gap="none"><Typo.Body>{item}</Typo.Body></Stack>)}
                    </Stack>
                  </Box>
                </Stack>
              ))}
            </Stack>
          </PageContainer>
        </Box>
      </ScrollArea>
    </Stack>
  );
}
