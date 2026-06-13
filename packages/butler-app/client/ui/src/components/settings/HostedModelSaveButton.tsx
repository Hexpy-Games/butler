import { Button } from "@/butler-ds";

interface HostedModelSaveButtonProps {
  busy: boolean;
  disabled: boolean;
  label: string;
  savingLabel: string;
  onClick: () => void;
}

export function HostedModelSaveButton({
  busy,
  disabled,
  label,
  savingLabel,
  onClick,
}: HostedModelSaveButtonProps) {
  return (
    <Button type="button" disabled={disabled || busy} onClick={onClick}>
      {busy ? savingLabel : label}
    </Button>
  );
}
