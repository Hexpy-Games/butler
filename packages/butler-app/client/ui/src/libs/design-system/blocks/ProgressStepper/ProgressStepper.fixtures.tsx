import { ProgressStepper } from "./ProgressStepper";

export function ProgressStepperFixture() {
  return (
    <ProgressStepper
      activeIndex={1}
      steps={[
        { id: "language", label: "Language" },
        { id: "safety", label: "Safety" },
        { id: "install", label: "Install" },
        { id: "model", label: "Model" },
      ]}
    />
  );
}
