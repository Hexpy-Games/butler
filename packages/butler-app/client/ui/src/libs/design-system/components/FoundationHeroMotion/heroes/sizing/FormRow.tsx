import { Button } from "../../../Button";
import { SelectButton } from "../../../Select";
import { type SizingCopy } from "./sizingCopy";
import s from "./SizingHero.module.css";

/** A form row on one rail: the model picker and its buttons, all md 30, on one pair of rail lines. */
export function FormRow({ copy }: { copy: SizingCopy }) {
  return (
    <span className={s.formRow}>
      <SelectButton aria-label={copy.model} data-size="sm">{copy.auto}</SelectButton>
      <Button text={copy.cancel} variant="outline" />
      <Button text={copy.save} />
      <span className={s.formRail} />
    </span>
  );
}
