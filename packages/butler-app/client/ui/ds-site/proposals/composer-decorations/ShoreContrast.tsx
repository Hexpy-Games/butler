import { Grid, Stack, Tag, Typo } from "@/butler-ds";
import { MEASURED, MEASURED_ON, type ContrastRow } from "./measuredContrast";

const COLUMNS: Array<[keyof ContrastRow, string, number]> = [
  ["primary", "Primary", 4.5], ["placeholder", "Placeholder", 3], ["secondary", "Secondary", 3], ["icons", "Icons", 3],
];

function Value({ label, value, floor }: { label: string; value: number; floor: number }) {
  return (
    <Stack align="row" gap="xs">
      <Typo.Caption tone="secondary">{label}</Typo.Caption>
      <Typo.Body>{value.toFixed(2)}</Typo.Body>
      {value < floor ? <Tag tone="danger" size="sm">{`below ${floor}`}</Tag> : null}
    </Stack>
  );
}

/**
 * Worst measured contrast per scene / option / theme: the art right behind every glyph and
 * icon (glyphs hidden), over four animation frames, at 1280 and 375, at rest and open with a
 * long draft. Floors: primary 4.5:1, placeholder/secondary/icons 3:1.
 */
export function ShoreContrastTable() {
  return (
    <Stack gap="lg">
      <Grid columns={{ base: "1", wide: "2" }} gap="lg">
        {MEASURED.map((row) => (
          <Stack gap="xs" key={row.id}>
            <Typo.Label>{`${row.label} · ${row.theme}`}</Typo.Label>
            <Stack align="row" gap="md" wrap>
              {COLUMNS.map(([key, label, floor]) => <Value key={key} label={label} value={row.values[key]} floor={floor} />)}
            </Stack>
          </Stack>
        ))}
      </Grid>
      <Typo.Caption tone="secondary">{`Measured ${MEASURED_ON} in Chromium on this build. (c) removes the scene, so the card is plain glass.`}</Typo.Caption>
    </Stack>
  );
}
