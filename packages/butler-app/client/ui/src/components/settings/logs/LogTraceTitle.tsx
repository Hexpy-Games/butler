import { appCopy, useAppLocale } from "@/app/copy.ts";
import {
  Breadcrumb, BreadcrumbButton, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator,
} from "@/butler-ds";

/** 로그 › 메시지 추적 under the page title; 로그 returns to the log list. */
export function LogTraceTitle({ onLogs }: { onLogs: () => void }) {
  useAppLocale();
  return (
    <Breadcrumb label={appCopy.common.breadcrumb} data-test-class="logs-trace-nav">
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbButton onClick={onLogs}>{appCopy.settings.sections.logs}</BreadcrumbButton>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>{appCopy.settings.logs.trace.title}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
