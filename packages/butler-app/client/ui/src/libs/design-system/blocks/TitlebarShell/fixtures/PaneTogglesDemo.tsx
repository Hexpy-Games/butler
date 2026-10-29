import { Stack } from "../../../components/Stack";
import { dsClass } from "../../../lib/internal";
import styles from "../TitlebarShell.module.css";
import { GroupedTitlebar } from "./SplitTitlebarDemo";

const ROWS = [
  { key: "closed" },
  { key: "aside", open: true },
  { key: "viewer", paneOpen: "viewer" },
  { key: "browser", paneOpen: "browser" },
] as const satisfies ReadonlyArray<{ key: string; open?: boolean; paneOpen?: "browser" | "viewer" }>;

/**
 * Pane toggles on the cards frame's shell surface: all closed, then each pane open. An open pane's toggle fills
 * with that pane's own surface, opaque (IconButton `pane`); the browser and the file viewer share the right region,
 * so only one of them is ever open. The open 세션 정보 row keeps the attention dot on the fill.
 */
export function PaneToggles({ locale }: { locale: "en-US" | "ko-KR" }) {
  return (
    <Stack gap="sm">
      {ROWS.map((row) => (
        <div className={styles.fixture} data-surface="shell" data-pane-toggles={row.key} key={row.key}>
          <GroupedTitlebar locale={locale} pending={row.key === "aside"} open={"open" in row ? row.open : false} viewer
            paneOpen={"paneOpen" in row ? row.paneOpen : undefined} className={dsClass(styles.fixtureTitlebar)} />
        </div>
      ))}
    </Stack>
  );
}
