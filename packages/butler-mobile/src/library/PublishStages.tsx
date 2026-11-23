import { useEffect, useState } from "react";
import { Linking, Share, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { AppCopy } from "../../../butler-i18n/src/index.ts";
import type { LibraryItem } from "../../../butler-protocol/src/index.ts";
import { GatewayError, type GatewayClient } from "../../../butler-protocol/src/client/index.ts";
import { Button, icons, ListGroup, ListRow, showToast, Switch, useTokens } from "@/ds";
import { resultDescription } from "@/outputs/results";

export type PublishStage = "publish" | "published" | "stop" | "signedOut";
type Copy = AppCopy["publishing"];
type Preview = { file_count: number; size_bytes: number };
type Pages = { used: number; limit: number; badge: boolean; page_bytes: number; page_files: number };

function warn(error: unknown, copy: Copy, failed: string, pages?: Pages) {
  let message = failed;
  switch (error instanceof GatewayError ? error.code : undefined) {
    case "page_too_large": if (pages) message = copy.tooLarge(pages.page_bytes / 1e6, pages.page_files); break;
    case "page_refused": message = copy.refused; break;
    case "publish_daily_limit": message = copy.dailyLimit; break;
    case "paused": case "publish_capacity": message = copy.paused; break;
    case "cloud_unavailable": message = copy.offline; break;
    case "storage_full": message = copy.storageFull; break;
    case "page_taken_down": message = copy.pageTakenDown; break;
    case "publish_blocked": message = copy.publishBlocked; break;
  }
  showToast({ message, tone: "warning" });
}

export function usePublishStage({ client, item, stage, copy: P, failed, onStage, onClose, onChanged }: {
  client: GatewayClient | null; item: LibraryItem | null; stage: PublishStage | undefined; copy: Copy; failed: string;
  onStage(stage: PublishStage): void; onClose(): void; onChanged(): Promise<void>;
}) {
  const path = item ? `/library/${encodeURIComponent(item.id)}/publish` : undefined;
  const publishing = stage !== undefined;
  const [preview, setPreview] = useState<Preview>();
  const [pages, setPages] = useState<Pages>();
  const [publishedUrl, setUrl] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPreview(undefined);
    setPages(undefined);
    setUrl(undefined);
  }, [client, path, publishing]);
  useEffect(() => {
    if (!client || !path || stage !== "publish") return;
    let active = true;
    void Promise.all([client.request<Preview>(path), client.request<Pages>("/publishing/pages")]).then(([local, listed]) => {
      if (!active) return;
      setPreview(local);
      setPages(listed);
    }, error => {
      if (!active) return;
      if (error instanceof GatewayError && error.code === "butler_account_signed_out") onStage("signedOut");
      else warn(error, P, failed);
    });
    return () => { active = false; };
  }, [client, path, stage, onStage, P, failed]);

  if (!client || !item || !path || !stage) {
    return { title: "", description: undefined, action: undefined, body: null, busy: false };
  }

  const change = async () => {
    setBusy(true);
    try {
      if (stage === "stop") {
        await client.request(path, { method: "DELETE" });
        showToast({ message: P.stopped, tone: "success" });
        onClose();
      } else {
        const published = await client.request<NonNullable<LibraryItem["published"]>>(path, { method: "POST" });
        showToast({ message: P.published, tone: "success" });
        setUrl(published.url);
        onStage("published");
      }
      await onChanged();
    } catch (error) {
      if (error instanceof GatewayError && error.code === "butler_account_signed_out") onStage("signedOut");
      else if (error instanceof GatewayError && error.code === "page_limit") {
        setPages(undefined);
        try { setPages(await client.request<Pages>("/publishing/pages")); }
        catch (refreshError) {
          if (refreshError instanceof GatewayError && refreshError.code === "butler_account_signed_out") onStage("signedOut");
          else warn(refreshError, P, failed, pages);
        }
      } else warn(error, P, failed, pages);
    } finally { setBusy(false); }
  };

  const full = !!pages && pages.used >= pages.limit;
  const caption = full ? P.limitReached(pages.limit) : preview && pages
    ? P.files(preview.file_count, resultDescription("", preview.size_bytes)) + (pages.badge ? ` · ${P.badgeNote}` : "")
    : undefined;
  const url = publishedUrl ?? item.published?.url;
  return {
    title: stage === "stop" ? P.stopConfirm : stage === "published" ? P.sheetPublished : P.title,
    description: stage === "stop" ? P.stopBody : stage === "signedOut" ? P.signInOnPc : undefined,
    action: stage === "publish" ? <Button label={busy ? P.uploading : P.publish} disabled={busy || full || !preview || !pages} onPress={change} />
      : stage === "stop" ? <Button variant="destructive" label={P.stop} disabled={busy} onPress={change} /> : undefined,
    body: stage === "publish" ? <ListGroup footer={caption}>
      <ListRow title={P.privateOption} description={P.plusOnly}
        trailing={<Switch value={false} disabled label={P.privateOption} onValueChange={() => {}} />} />
    </ListGroup> : stage === "published" && url ? <PublishedStage item={item} url={url} copy={P}
      onStop={() => onStage("stop")} onError={error => warn(error, P, failed, pages)} /> : null,
    busy,
  };
}

function PublishedStage({ item, url, copy: P, onStop, onError }: {
  item: LibraryItem; url: string; copy: Copy; onStop(): void; onError(error: unknown): void;
}) {
  const t = useTokens();
  return <View style={{ gap: t.length("--space-4") }}>
    <ListRow icon={icons.Globe2} title={item.title} description={url} descriptionLines={1} />
    <ListGroup>
      <ListRow icon={icons.Link} title={P.copyLink} onPress={() => {
        void Clipboard.setStringAsync(url).then(() => showToast({ message: P.linkCopied, tone: "success" })).catch(onError);
      }} />
      <ListRow icon={icons.Share} title={P.share} onPress={() => { void Share.share({ message: url }).catch(onError); }} />
      <ListRow icon={icons.Eye} title={P.open} onPress={() => { void Linking.openURL(url).catch(onError); }} />
    </ListGroup>
    <ListGroup><ListRow icon={icons.Unlink} title={P.stop} destructive onPress={onStop} /></ListGroup>
  </View>;
}
