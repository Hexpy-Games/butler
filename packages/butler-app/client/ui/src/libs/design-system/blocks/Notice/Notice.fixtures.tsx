import { Notice } from "./Notice";
import { Stack } from "../../components/Stack";
import { AlertCircle, CircleAlert, CheckCircle2, CircleX } from "../../components/Icons";

export function NoticeFixture() {
  return (
    <Stack gap="2">
      <Notice
        tone="info"
        icon={<AlertCircle size={16} />}
        message="Your session has been saved"
      />
      <Notice
        tone="warning"
        icon={<CircleAlert size={16} />}
        message="This action cannot be undone"
      />
      <Notice
        tone="success"
        icon={<CheckCircle2 size={16} />}
        message="Project created successfully"
      />
      <Notice
        tone="error"
        icon={<CircleX size={16} />}
        message="Failed to connect to server"
      />
    </Stack>
  );
}
