import { appCopy } from "@/app/copy.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import type { SessionArtifactSummary } from "@/app/types.ts";
import type { ReactNode } from "react";
import { Button, ButtonContainer, Popup, Save, Tooltip } from "@/butler-ds";
import { artifactUrl } from "./artifactDisplay";

/** Types another app may open; the agent decides from the file's content and refuses the rest. */
const OPEN_IN_APP_EXTENSIONS = new Set(["pdf", "docx", "xlsx", "pptx", "hwp", "hwpx"]);

export interface ArtifactCardAction {
  id: string;
  label: string;
  ariaLabel: string;
  href?: string;
  download?: string;
  icon: ReactNode;
  onClick?: () => void;
}

export function artifactCardActions(
  artifact: SessionArtifactSummary,
): ArtifactCardAction[] {
  if (artifact.kind === "web") return [];
  const url = artifactUrl(artifact);
  const title = artifact.title || artifact.safe_path_label || "artifact";
  // Saved files keep their own name and extension; the title is display text only.
  const fileName = artifact.safe_path_label || title;
  const canUseDesktopSave =
    Boolean(artifact.file_id) &&
    typeof window !== "undefined" &&
    typeof window.butlerApp?.saveMessageFile === "function";
  if (canUseDesktopSave && artifact.file_id) {
    return [
      {
        id: "save",
        label: appCopy.artifacts.save,
        ariaLabel: `${appCopy.artifacts.save}: ${title}`,
        icon: <Save size="sm" />,
        onClick: () => {
          void saveDesktopArtifact(artifact.file_id!, fileName);
        },
      },
    ];
  }

  return [
    ...(url
      ? [
          {
            id: "save",
            label: appCopy.artifacts.save,
            ariaLabel: `${appCopy.artifacts.save}: ${title}`,
            href: url,
            download: fileName,
            icon: <Save size="sm" />,
          },
        ]
      : []),
  ];
}

/** Save for an artifact the app cannot preview (the desktop save dialog, or a download link on the web), and on the desktop "open in app". */
export function ArtifactSaveButton({ artifact }: { artifact: SessionArtifactSummary }) {
  const action = artifactCardActions(artifact).find((item) => item.id === "save");
  if (!action) return null;
  return (
    <ButtonContainer size="sm">
      {action.href ? (
        <Button asChild size="sm" variant="outline">
          <a aria-label={action.ariaLabel} download={action.download} href={action.href}>{action.label}</a>
        </Button>
      ) : <Button size="sm" variant="outline" iconStart={action.icon} text={action.label} aria-label={action.ariaLabel} onClick={action.onClick} />}
      <OpenInAppButton artifact={artifact} />
    </ButtonContainer>
  );
}

/** "Open in app" on the desktop for a type another app may open (disabled with a reason otherwise). */
export function OpenInAppButton({ artifact }: { artifact: SessionArtifactSummary }) {
  const fileId = artifact.file_id;
  if (!fileId || typeof window === "undefined" || typeof window.butlerApp?.openMessageFile !== "function") return null;
  const name = artifact.safe_path_label || artifact.title;
  const extension = /\.([^./\\]+)$/u.exec(name.trim())?.[1]?.toLocaleLowerCase("en-US") ?? "";
  const blocked = !OPEN_IN_APP_EXTENSIONS.has(extension);
  const label = appCopy.artifacts.openInApp;
  return (
    <Tooltip label={blocked ? appCopy.artifacts.openInAppBlocked : undefined}>
      <Button size="sm" variant="outline" iconStart={<Popup size="sm" />} text={label} disabled={blocked}
        aria-label={blocked ? `${label}. ${appCopy.artifacts.openInAppBlocked}` : `${label}: ${name}`}
        onClick={() => { void openInApp(fileId); }} />
    </Tooltip>
  );
}

async function openInApp(fileId: string): Promise<void> {
  try {
    const result = await window.butlerApp?.openMessageFile?.({ fileId }) as { opened?: boolean; code?: unknown } | undefined;
    if (result?.opened) return;
    const refused = typeof result?.code === "string" && result.code.startsWith("open_type_");
    notifyStatus(refused ? appCopy.artifacts.openInAppBlocked : appCopy.artifacts.openInAppFailed, { tone: "error" });
  } catch (error) {
    notifyError(error, appCopy.artifacts.openInAppFailed);
  }
}

async function saveDesktopArtifact(
  fileId: string,
  suggestedName: string,
): Promise<void> {
  try {
    const result = await window.butlerApp?.saveMessageFile?.({
      fileId,
      suggestedName,
    });
    if (isSavedResult(result)) {
      notifyStatus(appCopy.artifacts.saved, { tone: "ok" });
    }
  } catch (error) {
    notifyError(error, appCopy.artifacts.saveFailed);
  }
}

function isSavedResult(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "saved" in result &&
    (result as { saved?: unknown }).saved === true
  );
}
