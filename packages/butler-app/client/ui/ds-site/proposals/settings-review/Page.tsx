import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Box, PageContainer, ScrollArea, SegmentedControl, Stack, Tag, Typo } from "@/butler-ds";
import { PAGE_COPY } from "./copy";
import { CopyTable } from "./CopyTable";
import { ERROR_COPY, GRANT_COPY, MOTION_COPY, UPDATE_COPY } from "./proposedCopy";
import {
  choices, STAGE_MESSAGE, STAGE_SIZE, stateFromQuery, stateToQuery, type StageState, type StageWidth,
} from "./state";

function Control({ label, children }: { label: string; children: ReactNode }) {
  return <Stack gap="xs"><Typo.Label>{label}</Typo.Label>{children}</Stack>;
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

const RECOMMENDED: Partial<Record<keyof StageState, string>> = {
  updateVariant: "proposal", motionVariant: "accessibility", updatePlace: "sidebarRow",
};

/** "Proposals → Settings review": section switch, state controls, the width-true frame, notes. */
export function SettingsReviewPage() {
  const query = new URLSearchParams(location.search);
  const [state, setState] = useState<StageState>(() => stateFromQuery(query));
  const [width, setWidth] = useState<StageWidth>(() => (["desktop", "768", "375"].includes(query.get("width") ?? "") ? query.get("width") as StageWidth : "desktop"));
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [measureRef, available] = useAvailableWidth();
  const copy = PAGE_COPY[state.locale];
  const update = (patch: Partial<StageState>) => setState((current) => ({ ...current, ...patch }));
  const initialSrc = useMemo(() => `?${new URLSearchParams({ proposal: "settings-review", stage: "1", ...Object.fromEntries(stateToQuery(state)) })}`, []);

  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage({ type: STAGE_MESSAGE, state }, location.origin);
    document.body.classList.remove("theme-light", "theme-dark");
    document.body.classList.add(`theme-${state.theme}`);
    document.documentElement.lang = state.locale === "ko-KR" ? "ko" : "en";
    history.replaceState(null, "", `?${new URLSearchParams({ proposal: "settings-review", width, ...Object.fromEntries(stateToQuery(state)) })}`);
  }, [state, width]);
  useEffect(() => {
    const listen = (event: MessageEvent) => {
      if (event.origin === location.origin && event.data?.type === `${STAGE_MESSAGE}:patch`) update(event.data.patch);
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, []);

  const size = STAGE_SIZE[width];
  const scale = available > 0 ? Math.min(1, available / size.width) : 1;
  const segment = <K extends keyof StageState>(key: K, label: string, values: Record<string, string>) => (
    <Control label={label}>
      <SegmentedControl ariaLabel={label} size="sm" value={state[key] as string}
        options={choices(key).map((value) => ({ value: value as string, label: `${values[value as string]}${RECOMMENDED[key] === value ? " ★" : ""}` }))}
        onValueChange={(value) => update({ [key]: value } as Partial<StageState>)} />
    </Control>
  );
  const notes = copy.notes[state.section];
  const table = state.section === "updates" ? UPDATE_COPY : state.section === "motion" ? MOTION_COPY
    : state.section === "errors" ? ERROR_COPY : GRANT_COPY;

  return (
    <Stack gap="none" UNSAFE_style={{ height: "100dvh" }}>
      <ScrollArea fill dataTestClass="proposal-scroll">
        <Box surface="base" paddingY="xl">
          <PageContainer width="full">
            <Stack gap="xl">
              <Stack gap="sm">
                <Typo.Caption>{copy.eyebrow}</Typo.Caption>
                <Typo.H1>{copy.title}</Typo.H1>
                <Typo.Body>{copy.intro}</Typo.Body>
              </Stack>
              <Box surface="raised" border="hairline" radius="panel" padding="lg">
                <Stack gap="lg">
                  {segment("section", copy.controls.screen, copy.sections)}
                  <Stack align="row" wrap gap="lg" rowGap="md">
                    {state.section === "updates" ? <>
                      {segment("updatePlace", copy.controls.placement, copy.updatePlace)}
                      {state.updatePlace === "settings" ? segment("updateVariant", copy.controls.variant, copy.updateVariant) : null}
                      {segment("update", copy.controls.state, copy.update)}
                      {state.update === "failed" ? segment("failure", copy.controls.failure, copy.failure) : null}
                    </> : null}
                    {state.section === "motion" ? <>
                      {segment("motionVariant", copy.controls.variant, copy.motionVariant)}
                      {segment("motion", copy.controls.state, copy.motion)}
                    </> : null}
                    {state.section === "errors" ? <>
                      {segment("errorScreen", copy.controls.screen, copy.errorScreen)}
                      {state.errorScreen === "mcp" ? segment("mcpError", copy.controls.error, copy.mcpError) : null}
                    </> : null}
                    {state.section === "approvals" ? <>
                      {segment("reorgPage", copy.controls.screen, copy.reorgPage)}
                      {state.reorgPage === "security" ? segment("approvals", copy.controls.state, copy.approvals) : null}
                    </> : null}
                  </Stack>
                  <Stack align="row" wrap gap="lg" rowGap="md">
                    <Control label={copy.controls.width}>
                      <SegmentedControl ariaLabel={copy.controls.width} size="sm" value={width}
                        options={(["desktop", "768", "375"] as const).map((value) => ({ value, label: copy.widths[value] }))}
                        onValueChange={(value) => setWidth(value as StageWidth)} />
                    </Control>
                    {segment("theme", copy.controls.theme, copy.themes)}
                    {segment("wallpaper", copy.controls.wallpaper, copy.wallpapers)}
                    <Control label={copy.controls.language}>
                      <SegmentedControl ariaLabel={copy.controls.language} size="sm" value={state.locale}
                        options={[{ value: "ko-KR", label: "한국어" }, { value: "en-US", label: "English" }]}
                        onValueChange={(value) => update({ locale: value as StageState["locale"] })} />
                    </Control>
                  </Stack>
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
                {notes.map((note, index) => (
                  <Box key={note.title} surface="raised" border="hairline" radius="panel" padding="lg">
                    <Stack gap="sm">
                      <Stack align="row" gap="sm" cross="center">
                        <Typo.Label>{note.title}</Typo.Label>
                        {index === 0 ? <Tag>{copy.recommended}</Tag> : null}
                      </Stack>
                      {note.points.map((point) => <Typo.Body key={point}>{point}</Typo.Body>)}
                    </Stack>
                  </Box>
                ))}
              </Stack>

              <CopyTable title={copy.copyTable} columns={copy.copyColumns} existing={copy.existing} entries={table} />
              <Typo.Caption tone="tertiary" data-test-class="proposal-end">settings-review · design/settings-review</Typo.Caption>
            </Stack>
          </PageContainer>
        </Box>
      </ScrollArea>
    </Stack>
  );
}
