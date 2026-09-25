import { Stack } from "../../components/Stack";
import { QueuedMessage } from "./QueuedMessage";

const labels = {
  editLabel: "Edit queued message",
  deleteLabel: "Delete queued message",
  sendNowLabel: "Send now",
  sendNowHint: "Stop the current response and send this next",
};

export function QueuedMessageFixture() {
  return (
    <Stack gap="none">
      <QueuedMessage status="Queued · 1 of 2" {...labels} onSendNow={() => undefined}
        onEdit={() => undefined} onDelete={() => undefined}>
        Add screenshots to the final report before sending.
      </QueuedMessage>
      <QueuedMessage status="Queued · 2 of 2" {...labels} onEdit={() => undefined} onDelete={() => undefined}>
        Also mention that MCP secrets stay redacted.
      </QueuedMessage>
    </Stack>
  );
}
