import { useEffect, useId, useRef, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { Button, FieldError, IconButton, Input, Plus, Stack, Trash2, Typo } from "@/butler-ds";
import { normalizeAllowedHost } from "./allowedHostName";

/** Extra host names (tunnels, reverse proxies); each change saves the whole list. */
export function SecurityAllowedHostsField({
  hosts,
  otherHosts,
  disabled,
  onSave,
  content = false,
  describedBy,
}: {
  content?: boolean;
  describedBy: string;
  hosts: string[];
  otherHosts: string[];
  disabled: boolean;
  onSave: (hosts: string[]) => Promise<boolean>;
}) {
  const copy = appCopy.settings.security;
  const inputId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!disabled && restoreFocus.current) {
      restoreFocus.current = false;
      inputRef.current?.focus();
    }
  }, [disabled]);

  async function save(nextHosts: string[], focusInput = document.activeElement === inputRef.current) {
    restoreFocus.current = focusInput;
    return onSave(nextHosts);
  }

  async function add() {
    const host = normalizeAllowedHost(draft);
    if (!host) {
      setError(copy.invalidHost);
      return;
    }
    if (otherHosts.includes(host)) {
      setError(copy.sameHost);
      return;
    }
    if (hosts.includes(host)) {
      setDraft("");
      inputRef.current?.focus();
    } else if (await save([...hosts, host], true)) setDraft("");
  }

  return (
    <Stack gap="md">
      {hosts.length > 0 ? (
        <Stack gap="xs">
          {hosts.map((host) => (
            <Stack key={host} align="row" gap="sm" cross="center" justify="between">
              <Typo.Code wrap="anywhere">{host}</Typo.Code>
              <IconButton label={copy.removeHost(host)} disabled={disabled}
                onClick={() => void save(hosts.filter((item) => item !== host))}>
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
              aria-invalid={error ? true : undefined}
              aria-describedby={[describedBy, error ? errorId : undefined].filter(Boolean).join(" ")}
              onFocus={(event) => { inputRef.current = event.currentTarget; }}
              onChange={(event) => {
                setDraft(event.target.value);
                setError(null);
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
        {error ? <FieldError id={errorId}>{error}</FieldError> : null}
      </Stack>
    </Stack>
  );
}
