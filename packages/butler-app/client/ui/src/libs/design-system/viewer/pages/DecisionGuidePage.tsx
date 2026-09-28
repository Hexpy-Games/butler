import { useState } from "react";
import { EmptyLine } from "../../blocks/EmptyLine";
import { Button } from "../../components/Button";
import { ChevronRight } from "../../components/Icons";
import { Input } from "../../components/Input";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import type { ShowcaseEntry } from "../../showcase/collectShowcaseEntries";
import { decisionGuide } from "../decisionGuide";
import { PageHeader } from "../parts";
import styles from "../DesignSystemViewer.module.css";

/** "I need X → use Y", generated from every component's guidance. */
export function DecisionGuidePage({ entries, onOpen }: { entries: ShowcaseEntry[]; onOpen: (page: string) => void }) {
  const [query, setQuery] = useState("");
  const rows = decisionGuide(entries);
  const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
  const shown = rows.filter((row) => terms.every((term) => `${row.need} ${row.use}`.toLowerCase().includes(term)));
  return (
    <Stack gap="2xl" data-ds-decision-guide={rows.length}>
      <PageHeader eyebrow="Decision guide" title="I need X → use Y"
        lead="Describe the job, get the DS piece. Every row comes from a component's guidance (when to use it, and what to use instead), so the guide never drifts from the system.">
        <Input aria-label="Filter needs" placeholder="A need, e.g. confirm or loading" type="search"
          value={query} onChange={(event) => setQuery(event.target.value)} />
      </PageHeader>
      {shown.length === 0 ? <EmptyLine message="No need matches. Try fewer words, or search with ⌘K." /> : (
        <div className={styles.tokenTable}>
          {shown.map((row, index) => (
            <div className={styles.guideRow} key={`${row.need}-${row.use}-${index}`} data-ds-guide-row>
              <Typo.Body>{row.need}</Typo.Body>
              <Stack align="row" cross="center" gap="sm" wrap>
                {row.from ? <Typo.Caption tone="tertiary">{`instead of ${row.from}`}</Typo.Caption> : null}
                <Button size="sm" variant="outline" iconEnd={<ChevronRight size="sm" />} text={row.use} onClick={() => onOpen(row.target)} />
              </Stack>
            </div>
          ))}
        </div>
      )}
    </Stack>
  );
}
