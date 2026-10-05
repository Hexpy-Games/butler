import { useAppLocale } from "@/app/copy.ts";
import { appCopy, interfaceProgressLabel } from "@/app/copy.ts";
import { CircleAlert, IconSlot, Spinner } from "@/butler-ds";
import { spaceActivity } from "@/app/space/activity";
import type { SessionSummary } from "@/app/types";

export function SpaceActivity({ session }: { session?: SessionSummary }) {
  useAppLocale();
  const activity = spaceActivity(session);
  if (!activity) return null;
  return (
    <IconSlot
      size="sidebar"
      minHeight="line"
      passive
      role="status"
      aria-label={
        (activity === "attention" && session?.attention_required ? appCopy.space.attention : interfaceProgressLabel({ safe_label: session?.safe_status_label ?? "", interface_content: session?.safe_status_content, interface_label_key: session?.safe_status_label_key, interface_label_parameters: session?.safe_status_label_parameters })) ||
        (activity === "working" ? appCopy.space.working : appCopy.space.attention)
      }
    >
      {activity === "working" ? (
        <Spinner />
      ) : (
        <CircleAlert />
      )}
    </IconSlot>
  );
}
