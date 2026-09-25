import { Notice } from "./Notice";
import { Stack } from "../../components/Stack";
import { AlertCircle, CircleAlert, CheckCircle2, CircleX } from "../../components/Icons";

export function NoticeFixture() {
  return (
    <Stack gap="sm">
      <Notice
        tone="info"
        icon={<AlertCircle size="md" />}
        message="Your session has been saved"
      />
      <Notice
        tone="warning"
        icon={<CircleAlert size="md" />}
        message="This action cannot be undone"
      />
      <Notice
        tone="success"
        icon={<CheckCircle2 size="md" />}
        message="Project created successfully"
      />
      <Notice
        tone="error"
        icon={<CircleX size="md" />}
        message="Failed to connect to server"
      />
    </Stack>
  );
}
