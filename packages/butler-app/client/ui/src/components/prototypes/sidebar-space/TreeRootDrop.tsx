import { Typo } from "@/butler-ds";
import { useMock } from "@/app/prototypes/sidebar-space/mock-store";
import { useTreeDrag } from "./hooks/useTreeDrag";
import styles from "./SidebarInteractions.module.css";

export function TreeRootDrop() {
  const dragged = useTreeDrag((s) => s.dragged);
  const active = useTreeDrag((s) => s.target?.id === null);
  if (!dragged) return null;
  return (
    <div
      className={styles.rootDrop}
      data-active={active}
      data-tree-root-drop
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        useTreeDrag
          .getState()
          .over({ id: null, instance: "tree-root", position: "inside" });
      }}
      onDragLeave={() => useTreeDrag.getState().over(null)}
      onDrop={(event) => {
        event.preventDefault();
        useMock.getState().drop(dragged, null, "inside");
        useTreeDrag.getState().end();
      }}
    >
      <Typo.Caption>스페이스 최상위로 이동</Typo.Caption>
    </div>
  );
}
