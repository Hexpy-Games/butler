import { useAppLocale } from "@/app/copy.ts";
import { type ReactNode } from "react";
import { Field, FieldError, FieldLabel, Grid, KeyValueRow, Section, Stack } from "@/butler-ds";
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
import type { AutomationFormField } from "@/stores/automationForm.ts";
import { scheduleState } from "@/app/scheduleLabels";
import { ScheduleTimingFields } from "./ScheduleTimingFields";
import { AutomationAccessField } from "./AutomationAccessField";

interface AutomationFormProps {
  children?: ReactNode;
}

export function AutomationForm({ children }: AutomationFormProps) {
  useAppLocale();
  const title = useAutomationStore((state) => state.title);
  const promptBody = useAutomationStore((state) => state.promptBody);
  const targetSessionId = useAutomationStore((state) => state.targetSessionId);
  const sessionOptions = useAutomationStore((state) => state.sessionOptions);
  const state = useAutomationStore((state) => state.state);
  const saveError = useAutomationStore((state) => state.saveError);
  const setTitle = useAutomationStore((state) => state.setTitle);
  const setPromptBody = useAutomationStore((state) => state.setPromptBody);
  const setTargetSessionId = useAutomationStore(
    (state) => state.setTargetSessionId,
  );
  const copy = appCopy.automations;
  const errorFor = (field: AutomationFormField) =>
    saveError?.field === field ? saveError.message : undefined;

  return (
    <Grid columns="2" gap="xl">
      <Stack gap="md">
        <Field>
          <FieldLabel>{copy.fields.title}</FieldLabel>
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={copy.placeholders.title}
            aria-invalid={errorFor("title") ? true : undefined}
          />
          <FieldError>{errorFor("title")}</FieldError>
        </Field>
        <Field>
          <FieldLabel>{copy.fields.prompt}</FieldLabel>
          <Textarea
            value={promptBody}
            onChange={(event) => setPromptBody(event.target.value)}
            placeholder={copy.placeholders.prompt}
            rows={14}
            aria-invalid={errorFor("prompt") ? true : undefined}
          />
          <FieldError>{errorFor("prompt")}</FieldError>
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
        <AutomationAccessField />
        <ScheduleTimingFields />
        <KeyValueRow label={copy.fields.state} value={scheduleState(state)} />
        <FieldError>{errorFor("form")}</FieldError>
        {children}
      </Section>
    </Grid>
  );
}
