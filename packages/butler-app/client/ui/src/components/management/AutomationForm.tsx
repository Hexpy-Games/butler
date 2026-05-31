import { type ReactNode } from "react";
import { Field, FieldLabel, Grid, KeyValueRow, Section, Stack } from "@/butler-ds";
import { Input } from "@/butler-ds";
import { Textarea } from "@/butler-ds";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { useAutomationStore } from "@/stores/automationStore";

interface AutomationFormProps {
  children?: ReactNode;
}

export function AutomationForm({ children }: AutomationFormProps) {
  const title = useAutomationStore((state) => state.title);
  const promptBody = useAutomationStore((state) => state.promptBody);
  const targetSessionId = useAutomationStore((state) => state.targetSessionId);
  const intervalSeconds = useAutomationStore((state) => state.intervalSeconds);
  const sessionOptions = useAutomationStore((state) => state.sessionOptions);
  const state = useAutomationStore((state) => state.state);
  const setTitle = useAutomationStore((state) => state.setTitle);
  const setPromptBody = useAutomationStore((state) => state.setPromptBody);
  const setTargetSessionId = useAutomationStore(
    (state) => state.setTargetSessionId,
  );
  const setIntervalSeconds = useAutomationStore(
    (state) => state.setIntervalSeconds,
  );
  const intervalSelectValue = [600, 1800, 3600, 7200, 86400].includes(
    Number(intervalSeconds),
  )
    ? String(intervalSeconds)
    : "custom";
  const copy = appCopy.automations;

  return (
    <Grid columns="2" gap="xl">
      <Stack gap="md">
        <Field>
          <FieldLabel>{copy.fields.title}</FieldLabel>
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={copy.placeholders.title}
          />
        </Field>
        <Field>
          <FieldLabel>{copy.fields.prompt}</FieldLabel>
          <Textarea
            value={promptBody}
            onChange={(event) => setPromptBody(event.target.value)}
            placeholder={copy.placeholders.prompt}
            rows={14}
          />
        </Field>
      </Stack>
      <Section title={copy.fields.details}>
        <Field>
          <FieldLabel>{copy.fields.targetChat}</FieldLabel>
          <Select value={targetSessionId} onValueChange={setTargetSessionId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {sessionOptions.map((session) => (
                  <SelectItem key={session.id} value={session.id}>
                    {session.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel>{copy.fields.interval}</FieldLabel>
          <Select
            value={intervalSelectValue}
            onValueChange={(value) =>
              setIntervalSeconds(value === "custom" ? 900 : Number(value))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="600">10 minutes</SelectItem>
                <SelectItem value="1800">30 minutes</SelectItem>
                <SelectItem value="3600">1 hour</SelectItem>
                <SelectItem value="7200">2 hours</SelectItem>
                <SelectItem value="86400">24 hours</SelectItem>
                <SelectItem value="custom">Custom</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        {intervalSelectValue === "custom" && (
          <Field>
            <FieldLabel>{copy.fields.customMinutes}</FieldLabel>
            <Input
              type="number"
              min="5"
              max="1440"
              value={Math.round(Number(intervalSeconds) / 60)}
              onChange={(event) => {
                const minutes = Number(event.target.value);
                if (Number.isFinite(minutes))
                  setIntervalSeconds(Math.max(5, Math.min(1440, minutes)) * 60);
              }}
            />
          </Field>
        )}
        <KeyValueRow label={copy.fields.state} value={state} />
        {children}
      </Section>
    </Grid>
  );
}
