import { useEffect, useState, type ReactNode } from "react";
import { Box, ButlerThinkingMark, Stack, Tag, Typo } from "@/butler-ds";
import currentGif from "./current-install.gif";
import proposedGif from "./proposed-install.gif";
import { PAGE_COPY } from "./copy";
import type { ProposalLocale } from "./state";

/** Same schedule the generator steps at 20 Hz: logo hold, working, settle. */
const SCHEDULE: Array<["idle" | "working", number]> = [["idle", 500], ["working", 2500], ["idle", 3250]];

function useSchedule() {
  const [state, setState] = useState<"idle" | "working">("idle");
  useEffect(() => {
    let index = 0;
    let timer = 0;
    const next = () => {
      const [value, duration] = SCHEDULE[index % SCHEDULE.length]!;
      setState(value);
      index += 1;
      timer = window.setTimeout(next, duration);
    };
    next();
    return () => window.clearTimeout(timer);
  }, []);
  return state;
}

/** A desktop-like backdrop in both Windows themes, so contrast and edges show on each. */
function Desktops({ children }: { children: (theme: "light" | "dark") => ReactNode }) {
  return (
    <Stack align="row" gap="sm" wrap>
      {(["light", "dark"] as const).map((theme) => (
        <div key={theme} className={`theme-${theme}`}>
          <Box surface="muted" radius="panel" padding="md" border="hairline">{children(theme)}</Box>
        </div>
      ))}
    </Stack>
  );
}

function Gif({ src, label }: { src: string; label: string }) {
  return (
    <Stack gap="sm">
      <Typo.Label>{label}</Typo.Label>
      {/* The GIF file itself, shown at its 192×192 pixel size (1 GIF pixel = 1 CSS px, like Squirrel at 100%). */}
      <Desktops>{() => <img src={src} width={192} height={192} alt={label} />}</Desktops>
    </Stack>
  );
}

export function GifReview({ locale }: { locale: ProposalLocale }) {
  const copy = PAGE_COPY[locale];
  const state = useSchedule();
  return (
    <Stack gap="md">
      <Typo.H2>{copy.gifTitle}</Typo.H2>
      <Typo.Body>{copy.gifVerdict}</Typo.Body>
      <Stack align="row" gap="xl" rowGap="lg" wrap>
        <Gif src={currentGif} label={copy.gifCurrent} />
        <Stack gap="sm">
          <Stack align="row" gap="sm" cross="center">
            <Typo.Label>{copy.gifProposed}</Typo.Label>
            <Tag>{copy.recommended}</Tag>
          </Stack>
          <Desktops>{() => <img src={proposedGif} width={192} height={192} alt={copy.gifProposed} />}</Desktops>
        </Stack>
        <Stack gap="sm">
          <Typo.Label>{copy.gifLive}</Typo.Label>
          <div className="theme-light">
            <Box surface="base" radius="panel" padding="md" border="hairline">
              <Stack gap="none" UNSAFE_style={{ width: 168, height: 168 }}>
                <ButlerThinkingMark state={state} theme="light" />
              </Stack>
            </Box>
          </div>
        </Stack>
      </Stack>
      <Stack gap="xs">
        {copy.gifPlan.map((line) => <Typo.Body key={line}>{line}</Typo.Body>)}
      </Stack>
    </Stack>
  );
}
