import type { CSSProperties } from "react";
import { Section } from "../../components/Section";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { designSystemTokenGroups, type DesignSystemTokenGroup } from "../../registry";
import styles from "../DesignSystemViewer.module.css";

type Token = DesignSystemTokenGroup["tokens"][number];

function previewStyle(token: Token): CSSProperties {
  const style = { "--token-preview": token.value } as CSSProperties & Record<string, string>;
  if (token.kind === "type") {
    style[token.name.includes("weight") ? "--token-font-weight" : "--token-font-size"] = token.value;
  }
  return style;
}

function TokenRow({ token }: { token: Token }) {
  return (
    <Stack align="row" cross="center" gap="3" data-ds-token-kind={token.kind} data-ds-token-name={token.name}>
      <span aria-hidden="true" className={`${styles.tokenPreview} ${styles[`token-${token.kind}`] ?? ""}`}
        style={previewStyle(token)}>
        {token.kind === "type" ? "Aa" : null}
      </span>
      <Stack gap="1">
        <Typo.Code>{token.name}</Typo.Code>
        <Typo.Caption>{token.value}</Typo.Caption>
      </Stack>
    </Stack>
  );
}

export function FoundationsPage() {
  return (
    <Stack gap="2xl" data-ds-foundations>
      <Stack gap="sm">
        <Typo.H1>Foundations</Typo.H1>
        <Typo.Body>Design tokens from the Butler design-system token source, grouped by role.</Typo.Body>
      </Stack>
      {designSystemTokenGroups.map((group) => (
        <Section data-ds-token-group={group.name} description={`${group.tokens.length} tokens`}
          key={group.name} title={group.name} titleAs="h2">
          <div className={styles.tokenGrid}>
            {group.tokens.map((token) => <TokenRow key={token.name} token={token} />)}
          </div>
        </Section>
      ))}
    </Stack>
  );
}
