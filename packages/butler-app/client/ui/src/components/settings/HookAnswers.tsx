import { useEffect, useState } from "react";
import { api } from "@/app/api.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import { visibleText } from "@/app/visibleText.ts";
import { Button, ButtonContainer, CardList, CardListItem, Tooltip, Typo, X } from "@/butler-ds";
import { SettingsSection } from "./SettingsFormComponents";

interface HookAnswer { path: string; run: boolean }

/** Project folders with a saved answer about their hooks. Clearing one brings its question back. */
export function HookAnswers() {
  useAppLocale();
  const copy = appCopy.settings.hooks;
  const [answers, setAnswers] = useState<HookAnswer[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  async function refresh() {
    try { setAnswers(await api<HookAnswer[]>("/hooks/project-answers")); setFailed(false); }
    catch { setFailed(true); }
  }
  useEffect(() => { void refresh(); }, []);
  async function clear(path: string) {
    setBusy(true);
    try {
      setAnswers(await api<HookAnswer[]>("/hooks/project-answers/clear", { method: "POST", body: JSON.stringify({ path }) }));
      notifyStatus(copy.answerCleared, { tone: "ok" });
    } catch (error) { notifyError(error, appCopy.interfaceFeedback.requestFailed); await refresh(); }
    finally { setBusy(false); }
  }
  return <SettingsSection id="hook-folders" kind="list" title={copy.folders}
    state={answers ? (answers.length ? "ready" : "empty") : failed ? "error" : "loading"}
    emptyMessage={copy.foldersEmpty} onRetry={() => void refresh()}>
    <CardList>{(answers ?? []).map((answer) => <CardListItem key={answer.path}
      title={<Typo.Body as="span" wrap="anywhere"><bdi dir="ltr">{visibleText(answer.path)}</bdi></Typo.Body>}
      meta={answer.run ? copy.folderRuns : copy.folderDoesNotRun}
      actions={<ButtonContainer size="icon-xs">
        <Tooltip label={busy ? appCopy.settings.saving : copy.clearAnswer}>
          <Button size="icon-xs" variant="outline" aria-label={`${copy.clearAnswer}: ${answer.path}`} disabled={busy}
            onClick={() => void clear(answer.path)}><X size="sm" /></Button>
        </Tooltip>
      </ButtonContainer>} />)}</CardList>
  </SettingsSection>;
}
