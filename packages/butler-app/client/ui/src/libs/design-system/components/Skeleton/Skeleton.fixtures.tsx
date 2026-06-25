import { Stack, Skeleton } from "../../index";

export function SkeletonFixture() {
  return (
    <Stack gap="3">
      <Skeleton style={{ height: 18, width: "62%" }} />
      <Skeleton style={{ height: 12, width: "88%" }} />
      <Skeleton style={{ height: 12, width: "74%" }} />
    </Stack>
  );
}
