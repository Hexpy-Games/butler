import { ListChecks, Button } from "@/butler-ds";
import { useButlerStore } from "@/app/store.ts";

export function ViewTurnActivityButton({ count }: { count: number }) {
  const openTurnActivity = useButlerStore((state) => state.openTurnActivity);

  return (
    <Button
      aria-label={`이 턴의 전체 활동 ${count}개 보기`}
      data-test-class="view-turn-activity"
      iconStart={<ListChecks size={14} />}
      onClick={openTurnActivity}
      size="xs"
      text={`전체 활동 ${count}개 보기`}
      type="button"
      variant="borderless"
    />
  );
}
