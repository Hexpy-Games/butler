import { Section } from "../../components/Section";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import styles from "../DesignSystemViewer.module.css";

const PRINCIPLES: Array<{ title: string; rules: string[] }> = [
  {
    title: "Strong constraints",
    rules: [
      "Compose DS components; never write a new CSS module outside the allowlist.",
      "No className or style on DS components; no raw <button>, <input> or text elements.",
      "Tokens only: colors, type, spacing, radius and motion come from tokens.css.",
      "A missing capability becomes a DS component with a showcase and guidance first.",
    ],
  },
  {
    title: "Motion",
    rules: [
      "Linear-crisp: short decelerating entrances, faster exits, no bounce.",
      "Only DS components animate; product code never declares transitions.",
      "Compositor properties only (opacity, transform, color); reduced motion keeps fades.",
    ],
  },
  {
    title: "Verification",
    rules: [
      "lint:ds ratchets className, inline styles, raw elements and raw values to zero.",
      "lint:motion forbids motion outside the DS and keyword easings.",
      "The showcase coverage test requires a showcase, README and guidance for every export.",
    ],
  },
];

export function OverviewPrinciples() {
  return (
    <Section title="Principles" titleAs="h2">
      <div className={styles.cardGrid}>
        {PRINCIPLES.map((principle) => (
          <div className={styles.card} key={principle.title}>
            <Stack gap="sm">
              <Typo.PanelTitle>{principle.title}</Typo.PanelTitle>
              <Stack as="ul" gap="xs">
                {principle.rules.map((rule) => <li key={rule}><Typo.Caption>{rule}</Typo.Caption></li>)}
              </Stack>
            </Stack>
          </div>
        ))}
      </div>
    </Section>
  );
}
