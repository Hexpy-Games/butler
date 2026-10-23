import { appCopy } from "@/app/copy.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import type { SessionArtifactSummary } from "@/app/types.ts";
import type { ReactNode } from "react";
import { Button, ButtonContainer, Save } from "@/butler-ds";
import { artifactUrl } from "./artifactDisplay";

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

/** Save for an artifact the app cannot preview: the desktop save dialog, or a download link on the web. */
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
    </ButtonContainer>
  );
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
