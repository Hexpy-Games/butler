import { useState } from "react";
import { Stack } from "../../components/Stack";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { Typo } from "../../components/Typo";
import { NativeSelect, NativeSelectOption } from "../../components/NativeSelect";
import { BUILTIN_WALLPAPERS, wallpaperLabelText } from "../../blocks/Wallpaper";
import { StartupScreen } from "../recipes/StartupScreen";

const copy = {
  ko: { starting: "버틀러를 준비합니다…", agent: "에이전트를 시작합니다…", migration: "이전 버전을 정리합니다…", renderer: "화면을 준비합니다…",
    failed: "시작하지 못했습니다.", retry: "다시 시도", logs: "로그 보기", exported: "진단 로그를 내보냈습니다." },
  en: { starting: "Preparing Butler…", agent: "Starting agent…", migration: "Preparing upgrade…", renderer: "Preparing workspace…",
    failed: "Could not start Butler.", retry: "Retry", logs: "View logs", exported: "Diagnostics exported." },
};
type Stage = "starting" | "agent" | "migration" | "renderer" | "failed";
export function StartupPreview({ locale }: { locale: "ko" | "en" }) {
  const [wallpaper, setWallpaper] = useState("butler.bloom");
  const [stage, setStage] = useState<Stage>("starting");
  const [exported, setExported] = useState(false);
  const labels = copy[locale];
  return <Stack>
    <NativeSelect aria-label={locale === "ko" ? "배경" : "Wallpaper"} value={wallpaper} onChange={(event) => setWallpaper(event.target.value)}>
      <NativeSelectOption value="none">{locale === "ko" ? "없음" : "None"}</NativeSelectOption>
      {BUILTIN_WALLPAPERS.list().filter((module) => module.manifest.image !== "required").map((module) =>
        <NativeSelectOption key={module.manifest.id} value={module.manifest.id}>{wallpaperLabelText(module.manifest.name, locale === "ko" ? "ko-KR" : "en-US")}</NativeSelectOption>)}
    </NativeSelect>
    <ButtonContainer size="sm">
      {(["starting", "agent", "migration", "renderer", "failed"] as const).map((key) =>
        <Button key={key} size="sm" variant="secondary" onClick={() => { setStage(key); setExported(false); }}>{labels[key]}</Button>)}
    </ButtonContainer>
    <StartupScreen stage={stage} wallpaper={wallpaper} locale={locale}
      onRetry={() => { setStage("starting"); setExported(false); }} onLogs={() => setExported(true)} />
    {exported && <Typo.Caption role="status">{labels.exported}</Typo.Caption>}
  </Stack>;
}
