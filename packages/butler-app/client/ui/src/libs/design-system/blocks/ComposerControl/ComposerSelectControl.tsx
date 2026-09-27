import type { DsBaseProps } from "../../lib/dsProps";
import * as SelectPrimitive from "@radix-ui/react-select";
import type { ReactNode } from "react";
import { ComposerControl } from "./ComposerControl";

export interface ComposerSelectControlProps
  extends Omit<DsBaseProps<SelectPrimitive.SelectTriggerProps>, "asChild" | "children"> {
  icon?: ReactNode;
  /** Usually a `SelectValue`. */
  children: ReactNode;
}

/** Select trigger in the composer toolbar, styled as the other composer controls (e.g. access mode). */
export function ComposerSelectControl({ icon, children, ...props }: ComposerSelectControlProps) {
  return (
    <SelectPrimitive.Trigger asChild {...props}>
      <ComposerControl icon={icon} label={children} />
    </SelectPrimitive.Trigger>
  );
}
