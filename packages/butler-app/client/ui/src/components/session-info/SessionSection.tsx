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
  // Rows reach into the inline inset by their bleed (Clickable, 10px); the inset holds that hover fill and
  // its focus ring, so a fill stays inside the card on its own corners. Floating sections have no card edge.
  const content = <Box paddingX={layout === "docked" ? "lg" : "md"} paddingY={layout === "docked" ? "sm" : "md"}><Stack gap="sm">
    {title && <SessionSectionHeader title={title} count={count} />}
    {children}
  </Stack></Box>;
  return layout === "docked" ? <Card padding="none" data-session-section={id}>{content}</Card>
    : <Stack gap="sm" data-session-section={id}>{content}</Stack>;
}
