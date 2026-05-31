import { appCopy } from "@/app/copy.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import type { SessionArtifactSummary } from "@/app/types.ts";
import type { ReactNode } from "react";
import { Save } from "@/butler-ds";
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
  const url = artifactUrl(artifact);
  const title = artifact.title || artifact.safe_path_label || "artifact";
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
        icon: <Save size={13} />,
        onClick: () => {
          void saveDesktopArtifact(artifact.file_id!, title);
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
            download: title,
            icon: <Save size={13} />,
          },
        ]
      : []),
  ];
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
