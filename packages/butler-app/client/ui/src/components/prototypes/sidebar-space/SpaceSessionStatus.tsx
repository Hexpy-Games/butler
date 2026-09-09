import { CircleAlert, Circle } from "@/butler-ds";
import { useMock } from "@/app/prototypes/sidebar-space/mock-store";
import styles from "./SidebarInteractions.module.css";

export function SpaceSessionStatus({ id }: { id: string }) {
  const item = useMock((s) => s.items.find((row) => row.id === id)!);
  if (!item.activity) return null;
  return (
    <span
      className={styles.activity}
      data-attention={item.activity === "attention" || undefined}
      title={item.status}
      role="status"
      aria-label={item.status}
    >
      {item.activity === "working" ? (
        <Circle
          size={16}
          strokeDasharray="44 19"
          strokeLinecap="round"
          className={styles.spinner}
        />
      ) : (
        <CircleAlert size={16} />
      )}
    </span>
  );
}
