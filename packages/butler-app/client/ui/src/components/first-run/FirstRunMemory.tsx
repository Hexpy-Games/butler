import { ChoiceCard, ChoiceCardList, FileText, SetupWizardStepAction, Sparkles } from "@/butler-ds";
import { FirstRunStepCard } from "./FirstRunStepCard";
import type { FirstRunFlow } from "./useFirstRunFlow";

/** Memory model or text-only memory; a pick is required and only on downloads (in the background). */
export function FirstRunMemory({ flow }: { flow: FirstRunFlow }) {
  const { copy, memory } = flow;
  const options = [
    { value: "on" as const, icon: <Sparkles size="md" />, title: copy.memoryChoice.on, description: copy.memoryModel.description(),
      meta: memory.sizeMB ? copy.memoryChoice.size(memory.sizeMB) : undefined },
    { value: "off" as const, icon: <FileText size="md" />, title: copy.memoryChoice.off, description: copy.memoryChoice.offDescription, meta: undefined },
  ];
  const waiting = !memory.available;
  return (
    <FirstRunStepCard flow={flow} title={copy.memoryChoice.title} titleId="first-run-memory-title"
      description={copy.memoryChoice.lede} onBack={flow.backToConsent}
      actions={<SetupWizardStepAction forward disabled={!memory.value || memory.saving || waiting}
        title={waiting ? copy.prepWorking : undefined} onClick={memory.save}>{copy.memoryChoice.continue}</SetupWizardStepAction>}
    >
      <ChoiceCardList aria-labelledby="first-run-memory-title" role="radiogroup">
        {options.map((option) => (
          <ChoiceCard
            aria-checked={memory.value === option.value}
            chevron={false}
            data-memory-choice={option.value}
            description={option.description}
            icon={option.icon}
            key={option.value}
            meta={option.meta}
            role="radio"
            selected={memory.value === option.value}
            state={memory.saving ? "disabled" : "default"}
            title={option.title}
            onClick={() => memory.pick(option.value)}
          />
        ))}
      </ChoiceCardList>
    </FirstRunStepCard>
  );
}
