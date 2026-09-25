import { Skeleton, Stack } from "@/butler-ds";

const ROW_STYLE = { height: "var(--control-height-lg)" };

/** Placeholder rows while a settings list loads, so it never flashes "empty". */
export function SettingsListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <Stack gap="sm" aria-busy="true" data-test-class="settings-list-skeleton">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} style={ROW_STYLE} />
      ))}
    </Stack>
  );
}
