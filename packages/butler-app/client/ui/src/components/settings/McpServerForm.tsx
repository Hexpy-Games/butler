import { appCopy } from "@/app/copy.ts";
import type { McpTransportKind } from "@/app/types.ts";
import {
  Button,
  ButtonContainer,
  Field,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Stack,
  Switch,
} from "@/butler-ds";
import type { McpServerFormState } from "./mcpSettingsUtils";
import { HttpFields } from "./HttpFields";
import { StdioFields } from "./StdioFields";

export function McpServerForm({
  form,
  onChange,
  onCancel,
  onSave,
}: {
  form: McpServerFormState;
  onChange: (patch: Partial<McpServerFormState>) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const copy = appCopy.settings;
  return (
    <Stack gap="sm">
      <Field>
        <FieldLabel htmlFor="mcp-server-id">{copy.fields.mcpServerId}</FieldLabel>
        <Input
          id="mcp-server-id"
          value={form.id}
          onChange={(event) => onChange({ id: event.target.value })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="mcp-server-name">{copy.fields.mcpServerName}</FieldLabel>
        <Input
          id="mcp-server-name"
          value={form.displayName}
          onChange={(event) => onChange({ displayName: event.target.value })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="mcp-transport">{copy.fields.mcpTransport}</FieldLabel>
        <NativeSelect
          id="mcp-transport"
          value={form.transport}
          onChange={(event) =>
            onChange({ transport: event.target.value as McpTransportKind })
          }
        >
          <NativeSelectOption value="stdio">
            {copy.options.stdio}
          </NativeSelectOption>
          <NativeSelectOption value="http">
            {copy.options.http}
          </NativeSelectOption>
          <NativeSelectOption value="sse">
            {copy.options.sse}
          </NativeSelectOption>
        </NativeSelect>
      </Field>
      <Field>
        <FieldLabel htmlFor="mcp-enabled">{copy.fields.enabled}</FieldLabel>
        <Switch
          id="mcp-enabled"
          checked={form.enabled}
          onCheckedChange={(enabled) => onChange({ enabled })}
        />
      </Field>
      {form.transport === "stdio" ? (
        <StdioFields form={form} onChange={onChange} />
      ) : (
        <HttpFields form={form} onChange={onChange} />
      )}
      <ButtonContainer size="default" justify="end">
        <Button type="button" variant="outline" onClick={onCancel}>
          {appCopy.common.cancel}
        </Button>
        <Button type="button" onClick={onSave}>
          {appCopy.common.save}
        </Button>
      </ButtonContainer>
    </Stack>
  );
}
