import { useState } from "react";
import { View } from "react-native";
import { getAppCopy } from "../../../../butler-i18n/src/index.ts";
import { BrowserHandoffForm, SaveButtons, type InputKind } from "../../conversation/ApprovalCard";
import { useAppLocale } from "../../i18n";
import { useTokens } from "../../design/useTokens";
import { Button } from "../Button";
import { ButtonGroup } from "../ButtonGroup";
import { DecisionCard } from "../DecisionCard";
import { Text } from "../Text";

const noop = () => {};
const site = "example-shop.test", host = "login.example-shop.test";

/** The browser hand-off card: secure fields, typed values, the save-sign-in prompt, and the plain Stop/Done card. */
export function BrowserHandoffSection({ state }: { state?: string }) {
  const shown = (name: string) => !state || state === name;
  return <>
    {shown("fields") ? <Sample name="fields" fields={["username", "password"]} /> : null}
    {shown("typed") ? <Sample name="typed" fields={["username", "password"]} initial={{ username: "me@example.com", password: "correct-horse-42" }} /> : null}
    {shown("save") ? <Sample name="save" fields={[]} offer={{ username: "me@example.com", host }} /> : null}
    {shown("plain") ? <Sample name="plain" fields={[]} /> : null}
    {shown("live") ? <Sample name="live" fields={[]} /> : null}
  </>;
}

function Sample({ name, fields, initial = {}, offer }: {
  name: string; fields: InputKind[]; initial?: Partial<Record<InputKind, string>>; offer?: { username: string; host: string };
}) {
  const t = useTokens();
  const copy = getAppCopy(useAppLocale()), labels = copy.interfaceTemplates.approvalRequest.signInHandoff;
  const [values, setValues] = useState(initial);
  const form = fields.length > 0 || !!offer;
  return <View style={{ gap: t.length("--space-2"), paddingHorizontal: t.length("--adaptive-page-gutter") }}>
    <Text variant="caption" tone="tertiary">{name}</Text>
    <DecisionCard eyebrow={labels.eyebrow} title={copy.interfaceTemplates.approvalRequest.waitHandoff("sign_in")}
      actions={offer && !fields.length ? <SaveButtons labels={{ saveSignIn: copy.browser.saveSignIn, later: copy.browser.later }} onSave={noop} /> : <ButtonGroup layout="pair">
        <Button label={labels.stop} variant="secondary" onPress={noop} />
        <Button label={fields.length ? labels.submit : labels.done} onPress={noop} />
      </ButtonGroup>}>
      <BrowserHandoffForm labels={{ fields: labels.fields, savePrompt: labels.savePrompt, saveSignIn: copy.browser.saveSignIn, later: copy.browser.later }}
        host={form ? host : undefined} details={form ? [] : [site, labels.onDesktop]}
        fields={fields} values={values} onChange={(kind, value) => setValues({ ...values, [kind]: value })}
        onSubmit={noop} offer={offer} onSave={noop} />
      {name === "live" ? <ButtonGroup>
        <Button variant="secondary" label={labels.openScreen} onPress={noop} />
      </ButtonGroup> : null}
    </DecisionCard>
  </View>;
}
