import { useAppLocale } from "@/app/copy.ts";
import { appCopy, interfaceProgressLabel } from "@/app/copy.ts";
import { CircleAlert, IconSlot, Spinner, UnreadDot } from "@/butler-ds";
import { spaceActivity } from "@/app/space/activity";
import { useSessionUnread } from "@/app/space/unread";
import type { SessionSummary } from "@/app/types";

/** The row's one trailing mark at rest: attention, then working, then unread. */
export function SpaceActivity({ session, running = false, nested = false }: { session?: SessionSummary; running?: boolean; nested?: boolean }) {
  useAppLocale();
  const unread = useSessionUnread(session);
  const activity = running ? "working" : spaceActivity(session, nested);
  if (!activity) return <UnreadDot label={appCopy.space.unread} present={unread} />;
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
