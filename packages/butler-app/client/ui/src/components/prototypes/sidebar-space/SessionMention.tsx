import { MessageSquare, Notebook } from "@/butler-ds";
import styles from "./SessionMention.module.css";

export function SessionMention({
  title,
  project = false,
}: {
  title: string;
  project?: boolean;
}) {
  return (
    <span className={styles.mention}>
      {project ? (
        <Notebook aria-hidden="true" />
      ) : (
        <MessageSquare aria-hidden="true" />
      )}
      {title}
    </span>
  );
}
