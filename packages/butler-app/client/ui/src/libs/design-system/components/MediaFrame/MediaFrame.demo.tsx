// Showcase demos: pictures that arrive late, as they do over a network, so the load fade can be watched.
import { useEffect, useState } from "react";
import type { ShowcaseRenderContext } from "../../showcase";
import { Button } from "../Button";
import { Grid } from "../Grid";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { BROKEN_PICTURE, FIXTURE_FAVICON as FAVICON, fixturePicture } from "./fixtures";
import { MediaFrame, type MediaFrameProps } from "./MediaFrame";

/** `src` after `delay` ms, again on every `round` (a replay); undefined until then. */
export function useLateSrc(src: string, delay: number, round: number): string | undefined {
  const [shown, setShown] = useState<string | undefined>(undefined);
  useEffect(() => {
    setShown(undefined);
    const timer = window.setTimeout(() => setShown(src), delay);
    return () => window.clearTimeout(timer);
  }, [src, delay, round]);
  return shown;
}

const COPY = {
  "en-US": { cover: "Cover: fades in on load", contain: "Contain: fades in once its shape is known", failed: "Load error: the placeholder fades in", replay: "Replay" },
  "ko-KR": { cover: "채움: 불러오면 서서히 나타남", contain: "맞춤: 모양을 알면 서서히 나타남", failed: "불러오기 실패: 자리표시가 서서히 나타남", replay: "다시 보기" },
} as const;

type LateFrameProps = { caption: string; src: string; delay: number; round: number } & Pick<MediaFrameProps, "aspect" | "fit" | "placeholder" | "placeholderIcon" | "reducedMotion">;

function LateFrame({ caption, src, delay, round, placeholder, ...props }: LateFrameProps) {
  const late = useLateSrc(src, delay, round);
  return (
    <Stack gap="xs">
      {/* A new frame per replay. Until the late src arrives it is the bare matte, as a loading picture is. */}
      <MediaFrame key={round} {...props} placeholder={placeholder && late !== undefined} src={late} alt={caption} />
      <Typo.Caption tone="secondary">{caption}</Typo.Caption>
    </Stack>
  );
}

/** Three pictures that arrive late: a cover crop, a contained picture and one that fails. */
export function ImageLoadDemo({ locale, reducedMotion }: ShowcaseRenderContext & { reducedMotion?: boolean }) {
  const copy = COPY[locale];
  const [round, setRound] = useState(0);
  return (
    <Stack gap="md">
      <Grid columns={{ base: "3", compact: "1" }} gap="md">
        <LateFrame caption={copy.cover} aspect="1:1" fit="cover" placeholder placeholderIcon={FAVICON} src={fixturePicture("place")} delay={500} round={round} reducedMotion={reducedMotion} />
        <LateFrame caption={copy.contain} aspect="4:5" src={fixturePicture("product")} delay={900} round={round} reducedMotion={reducedMotion} />
        <LateFrame caption={copy.failed} aspect="1:1" fit="cover" placeholder placeholderIcon={FAVICON} src={BROKEN_PICTURE} delay={1300} round={round} reducedMotion={reducedMotion} />
      </Grid>
      <Stack align="row">
        <Button variant="secondary" size="sm" onClick={() => setRound((value) => value + 1)}>{copy.replay}</Button>
      </Stack>
    </Stack>
  );
}
