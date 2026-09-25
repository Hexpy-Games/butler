import { Wrench } from "../../components/Icons";
import { Typo } from "../../components/Typo";
import { DisclosureRow } from "./DisclosureRow";

export function DisclosureRowFixture() {
  return (
    <DisclosureRow
      icon={<Wrench size="md" />}
      title="Search"
      description="Project files"
      open
    >
      <Typo.Caption>Read-only file search completed.</Typo.Caption>
    </DisclosureRow>
  );
}
