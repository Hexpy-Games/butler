import { Button } from "../../components/Button";
import { Section } from "../../components/Section";
import { Stack } from "../../components/Stack";
import { tokenCatalog, tokenDefinitions } from "../foundations/catalog";
import { TokenRow } from "../foundations/TokenRow";
import { tokensByCategory, type TokenCategory } from "../foundations/tokenCatalog";
import { TOKEN_CATEGORY_TITLES } from "../pageTrail";
import { PageHeader } from "../parts";
import styles from "../DesignSystemViewer.module.css";

const LEADS: Record<TokenCategory, string> = {
  color: "Palette steps, semantic roles, app surfaces, glass, status, chart and syntax colors. Product code uses semantic and surface tokens; palette steps only feed them.",
  typography: "Type roles (H1–H6, body, caption, label, code and the compact app roles) plus font families, weights and line heights. Typo components consume them.",
  spacing: "The semantic spacing scale, layout bases, page widths and borders. Layout props (gap, padding) take the named steps.",
  radius: "Corner radii for controls, panels, popovers, the composer and pills.",
  shadow: "Elevation for cards, windows, controls, drag lift and glass surfaces.",
  "z-index": "The layering scale. Overlays opened inside dialogs stay above them.",
  motion: "Durations, easings, distances and loops. The Motion page plays each one.",
  focus: "The shared focus ring. Every focusable DS control draws it on :focus-visible.",
  sizing: "Control heights, menu rows, icon sizes, hit targets and chrome dimensions.",
  settings: "The settings spacing ramp: section header, card inset and field rhythm.",
  layout: "Safe areas, viewport and platform values the shell reads.",
};

export function TokenCategoryPage({ category, onOpen }: { category: TokenCategory; onOpen: (page: string) => void }) {
  const groups = tokensByCategory(tokenCatalog, category);
  const count = groups.reduce((total, group) => total + group.tokens.length, 0);
  return (
    <Stack gap="2xl" data-ds-foundations={category}>
      <PageHeader eyebrow={`Foundations · ${count} tokens`} title={TOKEN_CATEGORY_TITLES[category] ?? category} lead={LEADS[category]}>
        <Stack align="row" gap="sm" wrap>
          <Button size="sm" variant="outline" text="All foundations" onClick={() => onOpen("foundations")} />
          {category === "motion" ? <Button size="sm" text="Play them on the Motion page" onClick={() => onOpen("motion")} /> : null}
        </Stack>
      </PageHeader>
      {groups.map((group) => (
        <Section data-ds-token-group={group.group} description={`${group.tokens.length} tokens · light and dark side by side`}
          key={group.group} title={group.group} titleAs="h2">
          <div className={styles.tokenTable}>
            {group.tokens.map((token) => <TokenRow key={token.name} token={token} />)}
          </div>
        </Section>
      ))}
    </Stack>
  );
}

export const TOKEN_TOTALS = { definitions: tokenDefinitions.length, unique: tokenCatalog.length };
