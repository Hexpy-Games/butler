import { Box } from "../../components/Box";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { Section } from "../../components/Section";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { areas, parts } from "../../glossary/glossary";
import type { GlossaryPart } from "../../glossary/types";
import type { ShowcaseEntry } from "../../showcase/collectShowcaseEntries";
import { PageHeader } from "../parts";

// Secondary exports (ComposerCardEditor, Toaster, etc.) open their owning item.
const barrels = import.meta.glob<string>("../../{components,blocks}/*/index.ts", { query: "?raw", import: "default", eager: true });

function itemPage(name: string, entries: ShowcaseEntry[]): string | undefined {
  const direct = entries.find((entry) => entry.name === name);
  if (direct) return direct.id;
  const barrel = Object.entries(barrels).find(([, source]) => new RegExp(`\\b${name}\\b`, "u").test(source));
  const id = barrel?.[0].replace(/^\.\.\/\.\.\//u, "").replace(/\/index\.ts$/u, "");
  return entries.find((entry) => entry.id === id)?.id;
}

interface PartNode extends GlossaryPart {
  children: PartNode[];
}

const nodes = new Map(parts.map((part) => [part.id, { ...part, children: [] } as PartNode]));
for (const node of nodes.values()) {
  if (node.parent) nodes.get(node.parent)?.children.push(node);
}
const roots = areas.map((area) => ({ ...area, parts: [...nodes.values()].filter((part) => part.area === area.id && !part.parent) }));

type GlossaryProps = { entries: ShowcaseEntry[]; locale: "ko" | "en"; onOpen: (page: string) => void };

function PartEntry({ part, entries, locale, onOpen }: GlossaryProps & { part: PartNode }) {
  const ko = locale === "ko";
  return (
    <Stack as="li" gap="lg" id={part.id} data-ds-glossary-part={part.id}>
      <Stack gap="sm">
        <Typo.H3 wrap="anywhere" lang="ko">{part.ko}</Typo.H3>
        <Typo.Body tone="secondary" wrap="anywhere" lang="en">{part.en}</Typo.Body>
        <Typo.Body wrap="anywhere" lang="ko">{part.desc}</Typo.Body>
        {part.ds.length > 0 ? (
          <ButtonContainer size="sm" aria-label="DS">
            {part.ds.map((name) => {
              const target = itemPage(name, entries);
              return target ? <Button key={name} size="sm" variant="outline" text={name} onClick={() => onOpen(target)} />
                : <Typo.Caption key={name} wrap="anywhere">{name}</Typo.Caption>;
            })}
          </ButtonContainer>
        ) : null}
        {part.app.length > 0 ? (
          <Stack gap="xs" aria-label={ko ? "앱 파일" : "App files"}>
            {part.app.map((path) => <Typo.Caption key={path} tone="secondary" wrap="anywhere" literal>{path}</Typo.Caption>)}
          </Stack>
        ) : null}
        {part.avoid.length > 0 ? <Typo.Caption tone="tertiary" wrap="anywhere">{`${ko ? "이전에 쓰던 이름" : "Previously used names"}: ${part.avoid.join(", ")}`}</Typo.Caption> : null}
      </Stack>
      {part.children.length > 0 ? (
        <Box paddingStart="lg">
          <Stack as="ul" gap="xl">
            {part.children.map((child) => <PartEntry key={child.id} part={child} entries={entries} locale={locale} onOpen={onOpen} />)}
          </Stack>
        </Box>
      ) : null}
    </Stack>
  );
}

/** Canonical names stay bilingual; viewer chrome follows the locale switch. */
export function GlossaryPage({ entries, locale, onOpen }: GlossaryProps) {
  const ko = locale === "ko";
  return (
    <Stack gap="2xl" data-ds-glossary={parts.length}>
      <PageHeader title={ko ? "용어 사전 / Glossary" : "Glossary / 용어 사전"}
        lead={ko ? "UI 부분은 사전의 한국어·영어 이름으로 부릅니다. 이전 이름은 사용하지 않습니다." : "Call UI parts by their Korean or English glossary name. Do not use previous names."} />
      {roots.map((area) => (
        <Section key={area.id} title={`${area.ko} / ${area.en}`} titleAs="h2" data-ds-glossary-area={area.id}>
          <Stack as="ul" gap="xl">
            {area.parts.map((part) => <PartEntry key={part.id} part={part} entries={entries} locale={locale} onOpen={onOpen} />)}
          </Stack>
        </Section>
      ))}
    </Stack>
  );
}
