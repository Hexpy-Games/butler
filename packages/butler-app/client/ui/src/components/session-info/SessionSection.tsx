import { Children, Fragment, isValidElement, type ReactNode } from "react";
import { Box, Card, Separator, Stack, Typo, type AsideLayout } from "@/butler-ds";

export function SessionSectionHeader({ title, count }: { title: string; count?: number }) {
  return <Stack align="row" justify="between" cross="center" gap="sm">
    <Typo.Caption tone="secondary" weight="medium">{title}</Typo.Caption>
    {count !== undefined && <Typo.Caption tone="secondary" numeric="tabular">{count}</Typo.Caption>}
  </Stack>;
}

export function SessionSectionList({ layout, children }: { layout: AsideLayout; children: ReactNode }) {
  const sections = Children.toArray(children);
  return <Stack gap="md" data-test-class="session-sections">
    {sections.map((section, index) => <Fragment key={isValidElement(section) ? section.key : index}>
      {layout === "floating" && index > 0 && <Separator space="none" />}
      {section}
    </Fragment>)}
  </Stack>;
}

export function SessionSection({ id, layout, title, count, children }: {
  id: string; layout: AsideLayout; title?: string; count?: number; children: ReactNode;
}) {
  // Floating sections have no card edge, so they keep the larger inset the inline-edit hover bleed and ring need.
  const content = <Box padding={layout === "docked" ? "sm" : "md"}><Stack gap="sm">
    {title && <SessionSectionHeader title={title} count={count} />}
    {children}
  </Stack></Box>;
  return layout === "docked" ? <Card padding="none" data-session-section={id}>{content}</Card>
    : <Stack gap="sm" data-session-section={id}>{content}</Stack>;
}
