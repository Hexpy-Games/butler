import { Button } from "./Button";
import { ChevronRight } from "../Icons";

export function ButtonFixture() {
  return (
    <div data-ds-fixture="button">
      <Button
        iconEnd={<ChevronRight size={14} />}
        text="Activity · Report · 10 records"
        type="button"
        variant="inline"
      />
    </div>
  );
}
