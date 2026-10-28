import { useId } from "react";
import { Field, FieldTitle, Typo } from "@/butler-ds";

export function CanonProposalFact({ label, value }: { label: string; value: string }) {
  const id = useId();
  return <Field orientation="vertical" aria-labelledby={id}>
    <FieldTitle id={id}>{label}</FieldTitle>
    <Typo.Body wrap="anywhere">{value}</Typo.Body>
  </Field>;
}
