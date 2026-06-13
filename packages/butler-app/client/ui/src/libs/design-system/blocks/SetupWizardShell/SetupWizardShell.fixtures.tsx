import { Button } from "../../components/Button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../shadcn/ui/select";
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
        <Select defaultValue="en">
          <SelectTrigger aria-label="Language">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="ko">Korean</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button type="button">Continue</Button>
      </SetupWizardContent>
    </SetupWizardShell>
  );
}
