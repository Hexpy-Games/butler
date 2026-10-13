import type { ReactNode } from "react";
import { CheckIcon, ChoiceCard } from "@/butler-ds";

/**
 * One item of a multi-pick ChoiceCardList (role="group"): the whole card toggles it, a check on the right
 * marks it picked. A blocked item is disabled and says why in its description.
 */
export function PickCard({ on, blocked = false, busy = false, icon, title, description, onToggle, ...data }: {
  on: boolean; blocked?: boolean; busy?: boolean; icon: ReactNode; title: string; description: string; onToggle: () => void;
} & Record<`data-${string}`, string>) {
  const checked = on && !blocked;
  return (
    <ChoiceCard {...data} role="checkbox" aria-checked={checked} selected={checked} chevron={false}
      meta={checked ? <CheckIcon size="md" /> : undefined} state={blocked || busy ? "disabled" : "default"}
      icon={icon} title={title} description={description} onClick={onToggle} />
  );
}
