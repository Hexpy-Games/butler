import { SettingsField } from "../../../../blocks/SettingsField";
import { SettingsSection } from "../../../../blocks/SettingsSection";
import { Button } from "../../../Button";
import { ButtonContainer } from "../../../ButtonContainer";
import { Card } from "../../../Card";
import { Field, FieldGroup, FieldLabel } from "../../../Field";
import { Input } from "../../../Input";
import { Stack } from "../../../Stack";
import { Switch } from "../../../Switch";
import { Typo } from "../../../Typo";
import { spaceToken, valueLabel } from "../shared/labels";
import { Mark } from "../shared/Mark";
import { Reveal as R } from "../shared/Reveal";
import { Topic } from "../shared/Topic";
import type { BuildSpec } from "../shared/types";
import type { SpacingCopy } from "./spacingCopy";

const space = valueLabel(spaceToken);

function field(id: string, label: string, value: string) {
  return (
    <Mark block n={id}>
      <Field>
        <FieldLabel><R name={`${id}-label`}>{label}</R></FieldLabel>
        <Mark block n={`${id}-input`} sketch sweep><Input readOnly value={value} /></Mark>
      </Field>
    </Mark>
  );
}

function settingsField(id: string, label: string, hint: string, on: boolean) {
  return (
    <Mark block n={id}>
      <SettingsField label={<R name={`${id}-label`}>{label}</R>} description={<R name={`${id}-hint`}>{hint}</R>}
        control={<Mark n={`${id}-sw`} part sketch><Switch aria-label={label} checked={on} onCheckedChange={() => undefined} /></Mark>} />
    </Mark>
  );
}

/**
 * Components by topic (inset, stack, inline, section rhythm): each is drawn
 * as its blueprint, filled, then its spaces fill as hatched bands under a
 * bracket, with a badge naming the space's token.
 */
export function spacingBuilds(copy: SpacingCopy): BuildSpec[] {
  const { topics } = copy;
  return [
    {
      id: "inset",
      render: (
        <Topic id="t1" title={topics.inset}>
          <Mark block n="card" sketch>
            <Card padding="md">
              <Stack gap="xs">
                <Mark n="c-title"><Typo.Label as="span"><R name="c-title">{copy.cardTitle}</R></Typo.Label></Mark>
                <Mark n="c-body"><Typo.Body tone="secondary"><R name="c-body">{copy.cardBody}</R></Typo.Body></Mark>
              </Stack>
            </Card>
          </Mark>
        </Topic>
      ),
      steps: [
        { text: ["t1-topic"] },
        { text: ["c-title"], annots: [{ kind: "pad", target: "card", label: space }] },
        { text: ["c-body"], annots: [{ kind: "gap", from: "c-title", to: "c-body", label: space }] },
      ],
    },
    {
      id: "stack",
      render: <Topic id="t2" title={topics.stack}><FieldGroup>{field("f1", copy.name, copy.nameValue)}{field("f2", copy.workspace, copy.workspaceValue)}</FieldGroup></Topic>,
      marks: { "f1-l": '[data-a="f1"] [data-slot="field-label"]' },
      steps: [
        { text: ["t2-topic"] },
        { text: ["f1-label"], parts: ["f1-input"], annots: [{ kind: "gap", from: "f1-l", to: "f1-input", label: space }] },
        { text: ["f2-label"], parts: ["f2-input"], annots: [{ kind: "gap", from: "f1", to: "f2", label: space }] },
      ],
    },
    {
      id: "inline",
      render: (
        <Topic id="t3" title={topics.inline}>
          <ButtonContainer size="default">
            <Mark n="b1" part sketch><Button text={<R name="b1-t">{copy.cancel}</R>} variant="outline" /></Mark>
            <Mark n="b2" part sketch><Button text={<R name="b2-t">{copy.save}</R>} /></Mark>
          </ButtonContainer>
        </Topic>
      ),
      steps: [
        { text: ["t3-topic"] },
        { parts: ["b1"], text: ["b1-t"] },
        { parts: ["b2"], text: ["b2-t"], annots: [{ kind: "gap", from: "b1", to: "b2", label: space }] },
      ],
    },
    {
      id: "section",
      render: (
        <Topic id="t4" title={topics.section}>
          <SettingsSection id="space-hero-section" kind="form">
            {settingsField("s1", copy.sync, copy.syncHint, true)}
            {settingsField("s2", copy.sounds, copy.soundsHint, false)}
          </SettingsSection>
        </Topic>
      ),
      marks: { card: '[data-slot="form-section-card"]' },
      steps: [
        { text: ["t4-topic"] },
        { text: ["s1-label", "s1-hint"], parts: ["s1-sw"], annots: [{ kind: "pad", target: "card", label: valueLabel("--settings-section-padding") }] },
        { text: ["s2-label", "s2-hint"], parts: ["s2-sw"], annots: [{ kind: "gap", from: "s1", to: "s2", label: valueLabel("--settings-field-gap") }] },
      ],
    },
  ];
}
