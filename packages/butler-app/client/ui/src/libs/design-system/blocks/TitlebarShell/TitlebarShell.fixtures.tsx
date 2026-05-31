import { Button } from "../../components/Button";
import { PanelLeft } from "../../components/Icons";
import { TitlebarShell } from "./TitlebarShell";
import styles from "./TitlebarShell.module.css";

export function TitlebarShellFixture() {
  return (
    <div className={styles.fixture}>
      <TitlebarShell
        className={styles.fixtureTitlebar}
        collapsed
        leading={<PanelLeft size={16} />}
        title="Butler"
        subtitle="Project workspace"
        trailing={<Button size="sm" variant="borderless">Settings</Button>}
      />
    </div>
  );
}
