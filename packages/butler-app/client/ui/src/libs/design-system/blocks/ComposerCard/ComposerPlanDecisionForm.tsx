import type { FormEvent } from "react";
import { Button } from "../../components/Button";
import { Input } from "../../components/Input";
import styles from "./ComposerPlanDecisionForm.module.css";

export interface ComposerPlanDecisionFormProps {
  ariaLabel: string;
  instruction: string;
  instructionLabel: string;
  instructionPlaceholder: string;
  acceptLabel: string;
  rejectLabel: string;
  submitLabel: string;
  pending?: boolean;
  onInstructionChange: (instruction: string) => void;
  onAccept: () => void;
  onReject: () => void;
  onSubmitInstruction: () => void;
}

export function ComposerPlanDecisionForm({
  ariaLabel,
  instruction,
  instructionLabel,
  instructionPlaceholder,
  acceptLabel,
  rejectLabel,
  submitLabel,
  pending = false,
  onInstructionChange,
  onAccept,
  onReject,
  onSubmitInstruction,
}: ComposerPlanDecisionFormProps) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmitInstruction();
  };
  return (
    <form
      aria-label={ariaLabel}
      className={styles.form}
      data-test-class="plan-decision-form"
      onSubmit={submit}
    >
      <div className={styles.actions}>
        <Button disabled={pending} size="sm" type="button" onClick={onAccept}>
          {acceptLabel}
        </Button>
        <Button
          disabled={pending}
          size="sm"
          type="button"
          variant="outline"
          onClick={onReject}
        >
          {rejectLabel}
        </Button>
      </div>
      <label className={styles.instruction}>
        <span className={styles.srOnly}>{instructionLabel}</span>
        <Input
          aria-label={instructionLabel}
          disabled={pending}
          placeholder={instructionPlaceholder}
          value={instruction}
          onChange={(event) => onInstructionChange(event.currentTarget.value)}
        />
      </label>
      <Button
        disabled={pending || !instruction.trim()}
        size="sm"
        type="submit"
        variant="secondary"
      >
        {submitLabel}
      </Button>
    </form>
  );
}
