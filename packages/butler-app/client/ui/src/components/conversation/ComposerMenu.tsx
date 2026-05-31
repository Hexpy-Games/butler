import type { ReactNode } from "react";
import { Stack } from "@/butler-ds";

export function ComposerMenu({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <Stack
      gap="xs"
      data-test-class="composer-menu"
      role="menu"
      aria-label={title}
    >
      <strong>{title}</strong>
      {children}
    </Stack>
  );
}
