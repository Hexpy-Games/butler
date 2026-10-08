import { useId, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { Button, FieldError, IconButton, Input, Plus, Stack, Trash2, Typo } from "@/butler-ds";
import { normalizeAllowedHost } from "./allowedHostName";

/** Extra host names (tunnels, reverse proxies); each change saves the whole list. */
export function SecurityAllowedHostsField({
  hosts,
  disabled,
  onSave,
  content = false,
  describedBy,
}: {
  content?: boolean;
  describedBy: string;
  hosts: string[];
  disabled: boolean;
  onSave: (hosts: string[]) => Promise<boolean>;
}) {
  const copy = appCopy.settings.security;
  const inputId = useId();
  const errorId = useId();
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);

  async function add() {
    const host = normalizeAllowedHost(draft);
    if (!host) {
      setInvalid(true);
      return;
    }
    if (hosts.includes(host) || await onSave([...hosts, host])) setDraft("");
  }

  return (
    <Stack gap="md">
      {hosts.length > 0 ? (
        <Stack gap="xs">
          {hosts.map((host) => (
            <Stack key={host} align="row" gap="sm" cross="center" justify="between">
              <Typo.Code wrap="anywhere">{host}</Typo.Code>
              <IconButton label={copy.removeHost(host)} disabled={disabled}
                onClick={() => void onSave(hosts.filter((item) => item !== host))}>
                <Trash2 size="sm" />
              </IconButton>
            </Stack>
          ))}
        </Stack>
      ) : null}
      <Stack gap="xs">
        <Stack align="row" gap="sm" cross="center">
          <Stack.Item grow minWidth="0">
            <Input
              id={inputId}
              aria-label={content ? copy.contentHosts : copy.hosts}
              disabled={disabled}
              autoComplete="off"
              spellCheck={false}
              placeholder={content ? copy.contentHostPlaceholder : copy.hostPlaceholder}
              value={draft}
              aria-invalid={invalid ? true : undefined}
              aria-describedby={[describedBy, invalid ? errorId : undefined].filter(Boolean).join(" ")}
              onChange={(event) => {
                setDraft(event.target.value);
                setInvalid(false);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || disabled || !draft.trim()) return;
                event.preventDefault();
                void add();
              }}
            />
          </Stack.Item>
          <Button type="button" size="lg" variant="outline" iconStart={<Plus size="sm" />} text={copy.addHost}
            disabled={disabled || !draft.trim()} onClick={() => void add()} />
        </Stack>
        {invalid ? <FieldError id={errorId}>{copy.invalidHost}</FieldError> : null}
      </Stack>
    </Stack>
  );
}
