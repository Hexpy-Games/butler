import { Button } from "../../components/Button";
import { NativeSelect, NativeSelectOption } from "../../components/NativeSelect";
import { Typo } from "../../components/Typo";
import {
  SetupWizardContent,
  SetupWizardShell,
} from "./SetupWizardShell";

export function SetupWizardShellFixture() {
  return (
    <SetupWizardShell
      activeIndex={0}
      title="Butler"
      steps={[
        { id: "language", label: "Language" },
        { id: "safety", label: "Safety" },
        { id: "install", label: "Install" },
        { id: "model", label: "Model" },
      ]}
    >
      <SetupWizardContent>
        <Typo.H3 as="h1">Language</Typo.H3>
        <NativeSelect aria-label="Language" defaultValue="en" stretch>
          <NativeSelectOption value="en">English</NativeSelectOption>
          <NativeSelectOption value="ko">Korean</NativeSelectOption>
        </NativeSelect>
        <Button type="button">Continue</Button>
      </SetupWizardContent>
    </SetupWizardShell>
  );
}
