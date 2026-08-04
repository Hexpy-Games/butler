import { Button, CircleAlert, Notice } from "@/butler-ds";

const GIT_INSTALL_URL = "https://git-scm.com/downloads";

export function GitDependencyNoticePresenter({
  actionLabel,
  message,
  title,
}: {
  actionLabel: string;
  message: string;
  title: string;
}) {
  return (
    <Notice
      action={
        <Button asChild size="sm" variant="outline">
          <a href={GIT_INSTALL_URL} rel="noreferrer" target="_blank">
            {actionLabel}
          </a>
        </Button>
      }
      icon={<CircleAlert size={18} />}
      message={message}
      title={title}
      tone="warning"
    />
  );
}
