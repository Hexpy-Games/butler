import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { Card } from "./Card";

export function CardFixture() {
  return (
    <Stack gap="2">
      <Card>
        <Typo.Body>Default card container</Typo.Body>
        <Typo.Caption>Matches DocumentTile and ResourceTile surface styling.</Typo.Caption>
      </Card>
      <Card selected interactive>
        <Typo.Body>Selected card container</Typo.Body>
        <Typo.Caption>Selection state keeps the same card silhouette.</Typo.Caption>
      </Card>
    </Stack>
  );
}
