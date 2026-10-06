import { useCallback, useEffect, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { openBrowser, useBrowserState } from "../browser/browserBridge";
import { useButlerStore } from "@/app/store";
import { api, apiErrorCode } from "@/app/api.ts";
import { ArtifactPreviewFrame, Button, ButtonContainer, NativeSelect, NativeSelectOption, Stack, Typo } from "@/butler-ds";

interface OutputView { url: string; revision: number; revisions: number[] }

/** Resolve a fresh capability on every open, reload and revision selection. */
export function OutputFrame({ outputId, title }: { outputId: string; title: string }) {
  useAppLocale();
  const [view, setView] = useState<OutputView | null>(null);
  const [revision, setRevision] = useState<number>();
  const [generation, setGeneration] = useState(0);
  const [failure, setFailure] = useState<string>();
  const copy = appCopy.artifacts;
  const browserEnabled = useBrowserState((state) => state.enabled);
  const sessionId = useButlerStore((state) => state.activeChatId);
  const load = useCallback(async () => {
    setFailure(undefined);
    try {
      const next = await api<OutputView>(`/outputs/${encodeURIComponent(outputId)}/view${revision ? `?revision=${revision}` : ""}`);
      const url = new URL(next.url);
      if (!["http:", "https:"].includes(url.protocol) || url.origin === location.origin) throw new Error("output_origin_refused");
      setView(next);
    } catch (error) {
      setView(null);
      setFailure(apiErrorCode(error) === "content_host_required" ? copy.contentHostRequired : copy.loadFailed);
    }
  }, [outputId, revision, copy.contentHostRequired, copy.loadFailed]);
  useEffect(() => { void load(); }, [load]);
  return (
    <Stack gap="sm">
      <Stack align="row" gap="sm" cross="center" wrap>
        <ButtonContainer size="xs">
          <Button size="xs" variant="outline" disabled={!view} title={failure} onClick={() => view && window.open(view.url, "_blank", "noopener,noreferrer")}>{copy.open}</Button>
          {window.butlerBrowser && <Button size="xs" variant="outline" disabled={!view || !browserEnabled} title={!browserEnabled ? appCopy.browser.updateRequired : undefined}
            onClick={() => view && void openBrowser({ url: view.url, sessionId })}>{appCopy.browser.openOutput}</Button>}
          <Button size="xs" variant="outline" onClick={() => { setGeneration((value) => value + 1); void load(); }}>{copy.reload}</Button>
        </ButtonContainer>
        {view && <NativeSelect aria-label={copy.revision} value={String(view.revision)} onChange={(event) => setRevision(Number(event.target.value))}>
          {view.revisions.map((value) => <NativeSelectOption key={value} value={String(value)}>{`${copy.revision} ${value}`}</NativeSelectOption>)}
        </NativeSelect>}
      </Stack>
      {view ? <ArtifactPreviewFrame key={`${outputId}-${view.revision}-${generation}`} src={view.url} title={title} sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups" referrerPolicy="no-referrer" /> : <Typo.Caption>{failure ?? copy.loading}</Typo.Caption>}
    </Stack>
  );
}
