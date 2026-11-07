import { openLink } from "@/components/browser/browserBridge";
import { useCallback, useEffect, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { openBrowser, useBrowserState } from "../browser/browserBridge";
import { useButlerStore } from "@/app/store";
import { api, apiErrorCode } from "@/app/api.ts";
import { ArtifactPreviewFrame, Button, ButtonContainer, NativeSelect, NativeSelectOption, Stack, Typo } from "@/butler-ds";

export interface OutputView { url: string; revision: number; revisions: number[] }

/** A page Butler made: its current view and what its controls do. */
export interface OutputViewState {
  view: OutputView | null;
  failure?: string;
  /** Changes on every revision selection and reload, so the frame loads again. */
  frameKey: string;
  selectRevision: (revision: number) => void;
  reload: () => void;
}

/** Resolve a fresh capability on every open, reload and revision selection. */
export function useOutputView(outputId: string, preview: boolean): OutputViewState {
  const [view, setView] = useState<OutputView | null>(null);
  const [revision, setRevision] = useState<number>();
  const [generation, setGeneration] = useState(0);
  const [failure, setFailure] = useState<string>();
  const copy = appCopy.artifacts;
  const load = useCallback(async () => {
    setFailure(undefined);
    try {
      const next = await api<OutputView>(`/${preview ? "previews" : "outputs"}/${encodeURIComponent(outputId)}/view${revision ? `?revision=${revision}` : ""}`);
      const url = new URL(next.url);
      if (!["http:", "https:"].includes(url.protocol) || url.origin === location.origin) throw new Error("output_origin_refused");
      setView(next);
    } catch (error) {
      setView(null);
      setFailure(apiErrorCode(error) === "content_host_required" ? copy.contentHostRequired : copy.loadFailed);
    }
  }, [outputId, preview, revision, copy.contentHostRequired, copy.loadFailed]);
  useEffect(() => { void load(); }, [load]);
  const reload = useCallback(() => { setGeneration((value) => value + 1); void load(); }, [load]);
  return { view, failure, frameKey: `${outputId}-${view?.revision}-${generation}`, selectRevision: setRevision, reload };
}

/** The page in its isolated frame, or its loading or failure line. */
export function OutputFrameView({ output, title }: { output: OutputViewState; title: string }) {
  return output.view
    ? <ArtifactPreviewFrame key={output.frameKey} src={output.view.url} title={title} sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups" referrerPolicy="no-referrer" />
    : <Typo.Caption>{output.failure ?? appCopy.artifacts.loading}</Typo.Caption>;
}

/** The page's revisions; choosing one shows it. */
export function OutputRevisionSelect({ view, onChange }: { view: OutputView; onChange: (revision: number) => void }) {
  const copy = appCopy.artifacts;
  return <NativeSelect aria-label={copy.revision} value={String(view.revision)} onChange={(event) => onChange(Number(event.target.value))}>
    {view.revisions.map((value) => <NativeSelectOption key={value} value={String(value)}>{`${copy.revision} ${value}`}</NativeSelectOption>)}
  </NativeSelect>;
}

/** A page Butler made inside a card: its own row (open, browser, reload, revision), then the page. */
export function OutputFrame({ outputId, title, preview = false, sessionId: ownerSession }: { outputId: string; title: string; preview?: boolean; sessionId?: string }) {
  useAppLocale();
  const output = useOutputView(outputId, preview);
  const { view, failure } = output;
  const copy = appCopy.artifacts;
  const browserEnabled = useBrowserState((state) => state.enabled);
  const activeSession = useButlerStore((state) => state.activeChatId);
  const sessionId = ownerSession || activeSession;
  return (
    <Stack gap="sm">
      <Stack align="row" gap="sm" cross="center" wrap>
        <ButtonContainer size="xs">
          <Button size="xs" variant="outline" disabled={!view} title={failure} onClick={() => view && void openLink(view.url)}>{copy.open}</Button>
          {window.butlerBrowser && <Button size="xs" variant="outline" disabled={!view || !browserEnabled} title={!browserEnabled ? appCopy.browser.updateRequired : undefined}
            onClick={() => view && void openBrowser({ url: view.url, sessionId, previewId: preview ? outputId : undefined })}>{appCopy.browser.openOutput}</Button>}
          <Button size="xs" variant="outline" onClick={output.reload}>{copy.reload}</Button>
        </ButtonContainer>
        {view && !preview && <OutputRevisionSelect view={view} onChange={output.selectRevision} />}
      </Stack>
      <OutputFrameView output={output} title={title} />
    </Stack>
  );
}
