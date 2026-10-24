import { Button, Tooltip } from "@/butler-ds";

interface HostedModelSaveButtonProps {
  busy: boolean;
  disabled: boolean;
  label: string;
  savingLabel: string;
  disabledHint?: string;
  onClick: () => void;
}

export function HostedModelSaveButton({
  busy,
  disabled,
  label,
  savingLabel,
  disabledHint,
  onClick,
}: HostedModelSaveButtonProps) {
  return (
    <Tooltip label={disabledHint}><Button type="button" disabled={disabled || busy} onClick={onClick}>
      {busy ? savingLabel : label}
    </Button></Tooltip>
  );
}
