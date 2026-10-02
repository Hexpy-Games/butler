import { useState } from "react";
import { useAppLocale } from "@/app/copy.ts";
import { WindowControls } from "@/components/layout/WindowControls";
import { Button, ButtonContainer, Field, FieldLabel, NativeSelect, NativeSelectOption,
  SetupWizardContent, SetupWizardShell, Stack, Typo } from "@/butler-ds";

const copy = {
  ko: {
    title: "이전 데이터 폴더예요",
    body: "이전 데이터는 그대로 보관돼요. Butler 0.0.20을 삭제한 뒤 .butler 폴더 이름을 바꾸고 다시 시작하세요.",
    language: "언어", folder: "폴더 열기", restart: "다시 시작",
  },
  en: {
    title: "An older data folder",
    body: "Your old data is preserved. Uninstall Butler 0.0.20, rename the .butler folder, then restart.",
    language: "Language", folder: "Open folder", restart: "Restart",
  },
};

/** A startup refusal has a usable desktop even while the Agent cannot start. */
export function LegacyDataRecovery() {
  const locale = useAppLocale();
  const [language, setLanguage] = useState<"ko" | "en">(locale === "ko-KR" ? "ko" : "en");
  const text = copy[language];
  return (
    <SetupWizardShell title="Butler" variant="focus" windowControls={<WindowControls />} data-test-class="legacy-data-recovery">
      <SetupWizardContent surface="solid">
        <Stack cross="center" gap="md">
          <Typo.H3 as="h1" align="center">{text.title}</Typo.H3>
          <Typo.Body align="center" tone="secondary">{text.body}</Typo.Body>
        </Stack>
        <Field>
          <FieldLabel htmlFor="legacy-data-language">{text.language}</FieldLabel>
          <NativeSelect id="legacy-data-language" size="sm" stretch value={language}
            onChange={(event) => setLanguage(event.target.value as "ko" | "en")}>
            <NativeSelectOption value="ko">한국어</NativeSelectOption>
            <NativeSelectOption value="en">English</NativeSelectOption>
          </NativeSelect>
        </Field>
        <ButtonContainer size="lg">
          <Button size="lg" stretch onClick={() => void window.butlerApp?.recoverLegacyData?.("open-folder")}>{text.folder}</Button>
          <Button size="lg" stretch variant="secondary" onClick={() => void window.butlerApp?.recoverLegacyData?.("restart")}>{text.restart}</Button>
        </ButtonContainer>
      </SetupWizardContent>
    </SetupWizardShell>
  );
}
