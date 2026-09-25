import { RowActionCluster } from "./RowActionCluster";
import { IconButton } from "../../components/IconButton";
import { Plus, Pencil, Trash2 } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import styles from "./RowActionCluster.module.css";

export function RowActionClusterFixture() {
  return (
    <Stack gap="2">
      <div className={styles.fixtureSurface}>
        <RowActionCluster>
          <IconButton label="Add"><Plus size="sm" /></IconButton>
          <IconButton label="Edit"><Pencil size="sm" /></IconButton>
          <IconButton label="Delete"><Trash2 size="sm" /></IconButton>
        </RowActionCluster>
      </div>
    </Stack>
  );
}
