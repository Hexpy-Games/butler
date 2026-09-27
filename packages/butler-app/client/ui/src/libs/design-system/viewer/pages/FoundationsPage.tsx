import type { CSSProperties } from "react";
import { Card } from "../../components/Card";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { tokenCatalog, tokenDefinitions } from "../foundations/catalog";
import { TOKEN_CATEGORIES, type TokenCategory } from "../foundations/tokenCatalog";
import { TOKEN_CATEGORY_TITLES } from "../pageTrail";
import { PageHeader } from "../parts";
import styles from "../DesignSystemViewer.module.css";

const PREVIEW: Partial<Record<TokenCategory, string[]>> = {
  color: ["--accent", "--color-success", "--color-warning", "--color-danger", "--text-primary", "--context-chart-2"],
};

export function FoundationsPage({ onOpen }: { onOpen: (page: string) => void }) {
  const legacy = tokenCatalog.filter((token) => token.legacy).length;
  return (
    <Stack gap="2xl" data-ds-foundations="index">
      <PageHeader eyebrow="Foundations" title="Tokens, generated from tokens.css"
        lead={`${tokenCatalog.length} tokens from ${tokenDefinitions.length} definitions (:root, .theme-light, .theme-dark, densities and media queries). Nothing here is hand-listed: edit tokens.css and these pages follow. ${legacy} legacy aliases are marked with their replacement.`} />
      <div className={styles.cardGrid}>
        {TOKEN_CATEGORIES.map((category) => {
          const tokens = tokenCatalog.filter((token) => token.category === category);
          return (
            <Card interactive key={category} aria-label={TOKEN_CATEGORY_TITLES[category]} onClick={() => onOpen(`foundations/${category}`)}
              data-ds-token-category={category}>
              <Stack gap="sm">
                <Typo.PanelTitle>{TOKEN_CATEGORY_TITLES[category]}</Typo.PanelTitle>
                <Typo.Caption tone="secondary">{`${tokens.length} tokens · ${new Set(tokens.map((token) => token.group)).size} groups`}</Typo.Caption>
                {PREVIEW[category] ? (
                  <div className={styles.swatchStrip}>
                    {PREVIEW[category]!.map((name) => <span className={styles.swatchDot} key={name} style={{ "--swatch": `var(${name})` } as CSSProperties} />)}
                  </div>
                ) : <Typo.Code>{tokens[0]?.name ?? ""}</Typo.Code>}
              </Stack>
            </Card>
          );
        })}
        <Card interactive aria-label="Motion" onClick={() => onOpen("motion")}>
          <Stack gap="sm">
            <Typo.PanelTitle>Motion (live)</Typo.PanelTitle>
            <Typo.Caption tone="secondary">Every duration and easing, played; DS motion components with replay.</Typo.Caption>
          </Stack>
        </Card>
      </div>
    </Stack>
  );
}
