import { appCopy, useAppLocale } from "@/app/copy.ts";
import { Field, FieldDescription, FieldLabel, Section, Switch, Tooltip } from "@/butler-ds";
import { useAutomationStore } from "@/stores/automationStore";
import { useVault } from "@/components/settings/useVault";

export function AutomationBrowserFields() {
  useAppLocale();
  const signin = useAutomationStore(state => state.browserSignin);
  const payment = useAutomationStore(state => state.browserPayment);
  const setSignin = useAutomationStore(state => state.setBrowserSignin);
  const setPayment = useAutomationStore(state => state.setBrowserPayment);
  const vault = useVault();
  const unavailable = vault.view?.available === false;
  const copy = appCopy.automations.browser;
  return <Section title={copy.title}>
    <Field>
      <FieldLabel htmlFor="schedule-browser-signin">{copy.signin}</FieldLabel>
      <FieldDescription id="schedule-browser-signin-description">{copy.signinDescription}</FieldDescription>
      <Switch id="schedule-browser-signin" aria-describedby="schedule-browser-signin-description" checked={signin} onCheckedChange={setSignin} />
    </Field>
    <Field>
      <FieldLabel htmlFor="schedule-browser-payment">{copy.payment}</FieldLabel>
      <FieldDescription id="schedule-browser-payment-description">{copy.paymentDescription}</FieldDescription>
      <Tooltip side="right" label={unavailable ? copy.unavailable : undefined}>
        <Switch id="schedule-browser-payment" aria-describedby="schedule-browser-payment-description" disabled={unavailable} checked={!unavailable && payment} onCheckedChange={setPayment} />
      </Tooltip>
    </Field>
  </Section>;
}
