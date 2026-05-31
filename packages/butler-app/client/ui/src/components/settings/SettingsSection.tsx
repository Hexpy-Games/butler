import type { ReactNode } from "react";
import { FormSection } from "@/butler-ds";

export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <FormSection title={title} description={description}>
      {children}
    </FormSection>
  );
}
