import { useAppLocale } from "@/app/copy.ts";
import { appCopy, interfaceProgressLabel } from "@/app/copy.ts";
import { Circle, CircleAlert } from "@/butler-ds";
import { spaceActivity } from "@/app/space/activity";
import type { SessionSummary } from "@/app/types";
import styles from "./SpaceInteractions.module.css";

export function SpaceActivity({ session, overlay = true }: { session?: SessionSummary; overlay?: boolean }) {
  useAppLocale();
  const activity = spaceActivity(session);
  if (!activity) return null;
  return (
    <span
      className={overlay ? styles.menuStatus : styles.activity}
      role="status"
      aria-label={
        interfaceProgressLabel({ safe_label: session?.safe_status_label ?? "", interface_content: session?.safe_status_content, interface_label_key: session?.safe_status_label_key, interface_label_parameters: session?.safe_status_label_parameters }) ||
        (activity === "working" ? appCopy.space.working : appCopy.space.attention)
      }
    >
      {activity === "working" ? (
        <Circle
          strokeDasharray="44 19"
          strokeLinecap="round"
          className={styles.spinner}
        />
      ) : (
        <CircleAlert />
      )}
    </span>
  );
}
