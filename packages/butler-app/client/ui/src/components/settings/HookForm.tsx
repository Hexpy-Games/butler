import { notifyError } from "@/app/notifications.ts";
import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { Button, ButtonContainer, Field, FieldLabel, Input, NativeSelect, NativeSelectOption, Stack, Switch } from "@/butler-ds";
import { blockingEvent, HOOK_EVENTS, type HookDefinition, type HookEvent } from "./hooksTypes";
export function HookForm({ hook, busy, onSave, onCancel }: {
  hook: HookDefinition; busy: boolean; onSave: (hook: HookDefinition) => void; onCancel: () => void;
}) {
  useAppLocale();
  const copy = appCopy.settings.hooks;
  const [form, setForm] = useState(hook);
  const [argv, setArgv] = useState(hook.args ? JSON.stringify(hook.args) : "");
  function update(patch: Partial<HookDefinition>) { setForm((current) => ({ ...current, ...patch })); }
  function save() {
    if (argv.trim()) {
      try {
        const parsed: unknown = JSON.parse(argv);
        if (!Array.isArray(parsed) || !parsed.every((v): v is string => typeof v === "string") || !parsed.length) throw new Error(copy.args);
        onSave({ ...form, args: parsed, command: null });
      } catch { notifyError(new Error(copy.args), appCopy.interfaceFeedback.requestFailed); return; }
    } else onSave({ ...form, args: null });
  }
  return <Stack gap="sm">
    <Field><FieldLabel htmlFor="hook-name">{copy.name}</FieldLabel>
      <Input id="hook-name" value={form.name ?? ""} onChange={(e) => update({ name: e.target.value })} /></Field>
    <Field><FieldLabel htmlFor="hook-event">{copy.event}</FieldLabel>
      <NativeSelect id="hook-event" value={form.event} onChange={(e) => {
        const event = e.target.value as HookEvent;
        update({ event, match: { tools: [] }, async: false });
      }}>{HOOK_EVENTS.map((event) => <NativeSelectOption key={event} value={event}>{event}</NativeSelectOption>)}</NativeSelect></Field>
    {form.event === "PreToolUse" || form.event === "PostToolUse" ? <Field>
      <FieldLabel htmlFor="hook-tools">{copy.tools}</FieldLabel>
      <Input id="hook-tools" value={form.match.tools.join(", ")} onChange={(e) => update({ match: {
        tools: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
      } })} /></Field> : null}
    <Field><FieldLabel htmlFor="hook-command">{copy.command}</FieldLabel>
      <Input id="hook-command" value={form.command ?? ""} disabled={Boolean(argv.trim())}
        onChange={(e) => update({ command: e.target.value })} /></Field>
    <Field><FieldLabel htmlFor="hook-args">{copy.args}</FieldLabel>
      <Input id="hook-args" value={argv} onChange={(e) => setArgv(e.target.value)} /></Field>
    <Field><FieldLabel htmlFor="hook-timeout">{copy.timeout}</FieldLabel>
      <Input id="hook-timeout" type="number" min={1} max={form.async ? 600000 : 120000} value={form.timeout_ms}
        onChange={(e) => update({ timeout_ms: Number(e.target.value) })} /></Field>
    {blockingEvent(form.event) ? <Field><FieldLabel htmlFor="hook-fail-closed">{copy.failClosed}</FieldLabel>
      <Switch id="hook-fail-closed" checked={form.failClosed} onCheckedChange={(failClosed) => update({ failClosed })} /></Field>
      : <Field><FieldLabel htmlFor="hook-async">{copy.async}</FieldLabel>
        <Switch id="hook-async" checked={form.async} onCheckedChange={(async) => update({ async })} /></Field>}
    <ButtonContainer size="default" justify="end">
      <Button variant="outline" disabled={busy} onClick={onCancel}>{appCopy.common.cancel}</Button>
      <Button disabled={busy || (!argv.trim() && !form.command?.trim())} onClick={save}>{appCopy.common.save}</Button>
    </ButtonContainer>
  </Stack>;
}
