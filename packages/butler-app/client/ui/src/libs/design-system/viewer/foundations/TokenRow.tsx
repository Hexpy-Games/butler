import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { CopyButton } from "../../components/CopyButton";
import { Stack } from "../../components/Stack";
import { Tag } from "../../components/Tag";
import { Typo } from "../../components/Typo";
import { tokenAnchor } from "../searchIndex";
import type { TokenCategory, TokenEntry } from "./tokenCatalog";
import styles from "../DesignSystemViewer.module.css";

const SAMPLE_CLASS: Partial<Record<TokenCategory, string>> = {
  color: styles.sample,
  spacing: styles.sampleSpace,
  settings: styles.sampleSpace,
  radius: styles.sampleRadius,
  shadow: styles.sampleShadow,
  sizing: styles.sampleSize,
};

function Sample({ token }: { token: TokenEntry }) {
  const style = { "--sample": `var(${token.name})` } as CSSProperties;
  if (token.category === "typography" && /-size(-|$)/u.test(token.name)) {
    return <span className={styles.sampleText} style={style}>Aa</span>;
  }
  const className = SAMPLE_CLASS[token.category];
  return className ? <span className={className} style={style} /> : <Typo.Caption tone="tertiary">{token.category}</Typo.Caption>;
}

/** Light and dark panes side by side; each reads the computed value live. */
function Pane({ token, theme, onValue }: { token: TokenEntry; theme: "light" | "dark"; onValue: (value: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) onValue(getComputedStyle(ref.current).getPropertyValue(token.name).trim());
  }, [token.name, onValue]);
  return <div className={`${styles.tokenPane} theme-${theme}`} ref={ref} data-ds-token-pane={theme}><Sample token={token} /></div>;
}

export function TokenRow({ token }: { token: TokenEntry }) {
  const [computed, setComputed] = useState<{ light?: string; dark?: string }>({});
  return (
    <div className={styles.tokenRow} id={tokenAnchor(token.name)} data-ds-token-name={token.name} data-ds-token-kind={token.category}>
      <div className={styles.tokenPair}>
        <Pane token={token} theme="light" onValue={(light) => setComputed((value) => (value.light === light ? value : { ...value, light }))} />
        <Pane token={token} theme="dark" onValue={(dark) => setComputed((value) => (value.dark === dark ? value : { ...value, dark }))} />
      </div>
      <Stack gap="xs" minWidth="0">
        <Stack align="row" cross="center" gap="xs" wrap>
          <Typo.Code>{token.name}</Typo.Code>
          {token.legacy ? <Tag tone="warning">{`legacy → ${token.legacy.replacement}`}</Tag> : null}
        </Stack>
        <Typo.Caption tone="secondary" wrap="anywhere">{token.dark ? `${token.light}  ·  dark: ${token.dark}` : token.light}</Typo.Caption>
      </Stack>
      <Stack gap="none" minWidth="0">
        <Typo.Caption tone="tertiary" wrap="anywhere">{computed.light ?? ""}</Typo.Caption>
        {computed.dark && computed.dark !== computed.light ? <Typo.Caption tone="tertiary" wrap="anywhere">{computed.dark}</Typo.Caption> : null}
        {token.overrides.length ? <Typo.Caption tone="tertiary">{`${token.overrides.length} context override${token.overrides.length > 1 ? "s" : ""}`}</Typo.Caption> : null}
      </Stack>
      <CopyButton text={`var(${token.name})`} label={`Copy var(${token.name})`} copiedLabel="Copied" />
    </div>
  );
}
