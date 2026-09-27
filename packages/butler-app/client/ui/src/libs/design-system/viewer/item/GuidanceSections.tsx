import { useEffect, useState } from "react";
import { EmptyLine } from "../../blocks/EmptyLine";
import { KeyValueRow } from "../../blocks/KeyValueRow";
import { Button } from "../../components/Button";
import { CheckIcon, ChevronRight, X } from "../../components/Icons";
import { Section } from "../../components/Section";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { recipeSource, type ShowcaseEntry } from "../../showcase/collectShowcaseEntries";
import type { ShowcaseGuidance, ShowcaseRenderContext } from "../../showcase";
import { findEntry } from "../decisionGuide";
import { CodeSample } from "../parts";
import { StoryCanvas } from "../StoryFrame";
import { TokenChip } from "../foundations/TokenChip";
import type { ViewerLocale } from "../viewerState";
import styles from "../DesignSystemViewer.module.css";

function Bullets({ items }: { items: string[] }) {
  return (
    <Stack gap="xs" as="ul">
      {items.map((item) => (
        <Stack align="row" as="li" cross="start" gap="sm" key={item}><Typo.Body>{`· ${item}`}</Typo.Body></Stack>
      ))}
    </Stack>
  );
}

export function UsageSection({ guidance, entries, onOpen }: { guidance: ShowcaseGuidance; entries: ShowcaseEntry[]; onOpen: (page: string) => void }) {
  return (
    <Section id="usage" title="When to use" titleAs="h2" data-ds-guidance="usage">
      <div className={styles.doDont}>
        <Stack gap="sm">
          <Stack align="row" cross="center" gap="xs"><CheckIcon size="sm" /><Typo.Label>Use it when</Typo.Label></Stack>
          <Bullets items={guidance.whenToUse} />
        </Stack>
        <Stack gap="sm">
          <Stack align="row" cross="center" gap="xs"><X size="sm" /><Typo.Label>Use something else when</Typo.Label></Stack>
          {guidance.whenNotToUse.map((alternative) => {
            const target = findEntry(entries, alternative.use);
            return (
              <Stack align="row" cross="center" gap="sm" justify="between" key={alternative.when} wrap>
                <Typo.Body>{alternative.when}</Typo.Body>
                <Button size="xs" variant="outline" iconEnd={<ChevronRight size="sm" />} text={alternative.use}
                  disabled={!target} onClick={() => target && onOpen(target.id)} />
              </Stack>
            );
          })}
        </Stack>
      </div>
    </Section>
  );
}

export function DoDontSection({ guidance, locale }: { guidance: ShowcaseGuidance; locale: ViewerLocale }) {
  const context: ShowcaseRenderContext = { locale: locale === "ko" ? "ko-KR" : "en-US" };
  return (
    <Section id="do-and-dont" title="Do and don't" titleAs="h2" data-ds-guidance="do-dont">
      {guidance.doDont.map((pair) => (
        <div className={styles.doDont} key={pair.do.caption}>
          {(["do", "dont"] as const).map((verdict) => (
            <div className={styles.verdict} data-verdict={verdict} key={verdict}>
              <div className={styles.verdictBody} lang={locale}>{pair[verdict].render(context)}</div>
              <div className={styles.verdictCaption}>
                <Typo.Caption tone={verdict === "do" ? "success" : "danger"}>{verdict === "do" ? "Do" : "Don't"}</Typo.Caption>
                <Typo.Body>{pair[verdict].caption}</Typo.Body>
              </div>
            </div>
          ))}
        </div>
      ))}
    </Section>
  );
}

export function RecipesSection({ entry, locale }: { entry: ShowcaseEntry; locale: ViewerLocale }) {
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void entry.loadGuidanceSource?.().then((text) => { if (live) setSource(text); });
    return () => { live = false; };
  }, [entry]);
  const recipes = entry.guidance?.recipes ?? [];
  return (
    <Section id="recipes" title="Composition recipes" titleAs="h2" data-ds-guidance="recipes">
      {recipes.map((recipe) => (
        <Section description={recipe.description} key={recipe.name} title={recipe.name} data-ds-recipe={recipe.name}>
          <StoryCanvas locale={locale} story={{ name: recipe.name, render: recipe.render }} />
          {source ? <CodeSample code={recipeSource(source, recipe.name) ?? ""} /> : null}
        </Section>
      ))}
    </Section>
  );
}

export function NotesSection({ guidance }: { guidance: ShowcaseGuidance }) {
  return (
    <Section id="content-and-accessibility" title="Content and accessibility" titleAs="h2" data-ds-guidance="notes">
      <div className={styles.doDont}>
        <Stack gap="sm"><Typo.Label>Content (en / ko)</Typo.Label><Bullets items={guidance.content} /></Stack>
        <Stack gap="sm"><Typo.Label>Accessibility</Typo.Label><Bullets items={guidance.accessibility} /></Stack>
      </div>
    </Section>
  );
}

export function TokensSection({ guidance, onOpen }: { guidance: ShowcaseGuidance; onOpen: (page: string) => void }) {
  return (
    <Section id="tokens" title="Related tokens" titleAs="h2" data-ds-guidance="tokens">
      {guidance.tokens.length === 0 ? <EmptyLine message="No tokens of its own; it composes other components." /> : (
        <Stack align="row" gap="xs" wrap>{guidance.tokens.map((name) => <TokenChip key={name} name={name} onOpen={onOpen} />)}</Stack>
      )}
      {guidance.internalExports ? (
        <Stack gap="xs">
          {Object.entries(guidance.internalExports).map(([name, reason]) => (
            <KeyValueRow key={name} label={name} value={reason} valueTextSize="caption" detailLayout="stack" />
          ))}
        </Stack>
      ) : null}
    </Section>
  );
}
