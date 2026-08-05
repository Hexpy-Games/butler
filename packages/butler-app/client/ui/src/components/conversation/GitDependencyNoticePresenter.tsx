import { Button, CircleAlert, IconButton, Notice, Stack, X } from "@/butler-ds";

const GIT_INSTALL_URL = "https://git-scm.com/downloads";

export function GitDependencyNoticePresenter({
  actionLabel,
  closeLabel,
  message,
  onDismiss,
  title,
}: {
  actionLabel: string;
  closeLabel: string;
  message: string;
  onDismiss: () => void;
  title: string;
}) {
  return (
    <Notice
      action={
        <Stack align="row" cross="center" gap="xs" justify="end" wrap>
          <Button asChild size="sm" variant="outline">
            <a href={GIT_INSTALL_URL} rel="noreferrer" target="_blank">
              {actionLabel}
            </a>
          </Button>
          <IconButton label={closeLabel} onClick={onDismiss}>
            <X size={16} />
          </IconButton>
        </Stack>
      }
      icon={<CircleAlert size={18} />}
      message={message}
      title={title}
      tone="warning"
    />
  );
}
