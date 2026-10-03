import { dsClass } from "../../lib/internal";
import styles from "./StartupScreen.module.css";
import { Box } from "../../components/Box";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { ButlerThinkingMark } from "../../components/ButlerThinkingMark";

/** Startup composition: the mark has its own quiet surface, separate from copy. */
export function StartupScreen({ status, failed, retryLabel, logsLabel, onRetry, onLogs, fill = false, theme, working = true, reducedMotion }: {
  working?: boolean; reducedMotion?: boolean; theme?: "light" | "dark"; fill?: boolean; status: string; failed: boolean; retryLabel: string; logsLabel: string;
  onRetry: () => void; onLogs: () => void;
}) {
  return <Box className={dsClass(styles.screen, fill && styles.fullscreen)} padding="xl" windowDrag="drag">
    <Stack cross="center" justify="center" gap="lg">
      <Stack UNSAFE_style={{ width: 96, height: 96 }}>
        <ButlerThinkingMark theme={theme} reducedMotion={reducedMotion} state={failed || !working ? "idle" : "working"} />
      </Stack>
      <Typo.Body role={failed ? "alert" : "status"} aria-live="polite">{status}</Typo.Body>
      {failed && <ButtonContainer size="sm">
        <Button size="sm" onClick={onRetry}>{retryLabel}</Button>
        <Button size="sm" variant="secondary" onClick={onLogs}>{logsLabel}</Button>
      </ButtonContainer>}
    </Stack>
  </Box>;
}
