import { Circle, CircleAlert } from "@/butler-ds";
import { spaceActivity } from "@/app/space/activity";
import type { SessionSummary } from "@/app/types";
import styles from "./SpaceInteractions.module.css";

export function SpaceActivity({ session, overlay = true }: { session?: SessionSummary; overlay?: boolean }) {
  const activity = spaceActivity(session);
  if (!activity) return null;
  return (
    <span
      className={overlay ? styles.menuStatus : styles.activity}
      role="status"
      aria-label={
        session?.safe_status_label ||
        (activity === "working" ? "작업 중" : "확인 필요")
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
