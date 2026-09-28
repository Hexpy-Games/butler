import { ArrowLeft, Button } from "@/butler-ds";

/** The small "back" action at the top of a first-run sub-view. */
export function FirstRunBack({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button iconStart={<ArrowLeft size="md" />} size="sm" text={label} type="button" variant="ghost" onClick={onClick} />
  );
}
