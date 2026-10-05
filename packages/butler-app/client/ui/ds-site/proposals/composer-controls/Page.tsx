import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Box, PageContainer, SegmentedControl, Stack, Switch, Tag, Typo } from "@/butler-ds";
import { PAGE_COPY } from "./copy";
import {
  DEFAULT_STATE, STAGE_MESSAGE, STAGE_SIZE, stateFromQuery, stateToQuery,
  type StageState, type StageWidth,
} from "./state";

function Control({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack gap="xs">
      <Typo.Label>{label}</Typo.Label>
      {children}
    </Stack>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <Control label={label}>
      <Switch aria-label={label} checked={checked} onCheckedChange={(value) => onChange(value === true)} />
    </Control>
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

/** "Proposals → Composer controls": controls for the preview plus the width-true preview frame. */
export function ComposerControlsProposalPage() {
  const query = new URLSearchParams(location.search);
  const [state, setState] = useState<StageState>(() => stateFromQuery(query));
  const [width, setWidth] = useState<StageWidth>(() => (["desktop", "768", "375"].includes(query.get("width") ?? "") ? query.get("width") as StageWidth : "desktop"));
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [measureRef, available] = useAvailableWidth();
  const copy = PAGE_COPY[state.locale];
  const update = (patch: Partial<StageState>) => setState((current) => ({ ...current, ...patch }));
  // The frame loads once with the initial state; later changes are posted in so menus and the
  // wallpaper keep running.
  const initialSrc = useMemo(() => `?${new URLSearchParams({ proposal: "composer-controls", stage: "1", ...Object.fromEntries(stateToQuery(state)) })}`, []);

  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage({ type: STAGE_MESSAGE, state }, location.origin);
    document.body.classList.remove("theme-light", "theme-dark");
    document.body.classList.add(`theme-${state.theme}`);
    document.documentElement.lang = state.locale === "ko-KR" ? "ko" : "en";
    const params = new URLSearchParams({ proposal: "composer-controls", width, ...Object.fromEntries(stateToQuery(state)) });
    history.replaceState(null, "", `?${params}`);
  }, [state, width]);

  const size = STAGE_SIZE[width];
  const scale = available > 0 ? Math.min(1, available / size.width) : 1;
  const option = <T extends string>(values: Record<T, string>) =>
    (Object.keys(values) as T[]).map((value) => ({ value, label: values[value] }));

  return (
    <Box surface="base" paddingY="xl">
    <PageContainer width="full">
      <Stack gap="xl" UNSAFE_style={{ minHeight: "100dvh" }}>
        <Stack gap="sm">
          <Typo.Caption>{copy.eyebrow}</Typo.Caption>
          <Typo.H1>{copy.title}</Typo.H1>
          <Typo.Body>{copy.intro}</Typo.Body>
        </Stack>

        <Box surface="raised" border="hairline" radius="panel" padding="lg">
          <Stack align="row" wrap gap="lg" rowGap="md">
            <Control label={copy.variant}>
              <SegmentedControl ariaLabel={copy.variant} size="sm" value={state.variant}
                options={option(copy.variants)} onValueChange={(value) => update({ variant: value as StageState["variant"] })} />
            </Control>
            <Control label={copy.width}>
              <SegmentedControl ariaLabel={copy.width} size="sm" value={width}
                options={option(copy.widths)} onValueChange={(value) => setWidth(value as StageWidth)} />
            </Control>
            <Control label={copy.theme}>
              <SegmentedControl ariaLabel={copy.theme} size="sm" value={state.theme}
                options={option(copy.themes)} onValueChange={(value) => update({ theme: value as StageState["theme"] })} />
            </Control>
            <Control label={copy.wallpaper}>
              <SegmentedControl ariaLabel={copy.wallpaper} size="sm" value={state.wallpaper}
                options={option(copy.wallpapers)} onValueChange={(value) => update({ wallpaper: value as StageState["wallpaper"] })} />
            </Control>
            <Control label={copy.state}>
              <SegmentedControl ariaLabel={copy.state} size="sm" value={state.mode}
                options={option(copy.modes)} onValueChange={(value) => update({ mode: value as StageState["mode"] })} />
            </Control>
            <Control label={copy.language}>
              <SegmentedControl ariaLabel={copy.language} size="sm" value={state.locale}
                options={[{ value: "ko-KR", label: "한국어" }, { value: "en-US", label: "English" }]}
                onValueChange={(value) => update({ locale: value as StageState["locale"] })} />
            </Control>
            <Toggle label={copy.plan} checked={state.plan} onChange={(plan) => update({ plan })} />
            <Toggle label={copy.question} checked={state.question} onChange={(question) => update({ question })} />
            <Toggle label={copy.attachment} checked={state.attachment} onChange={(attachment) => update({ attachment })} />
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
          {(["split", "cluster", "row"] as const).map((variant) => (
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
      </Stack>
    </PageContainer>
    </Box>
  );
}
