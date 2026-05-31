import { Button } from "../../components/Button";
import { Activity } from "../../components/Icons";
import { WorkerActivityRow } from "./WorkerActivityRow";

export function WorkerActivityRowFixture() {
  return (
    <WorkerActivityRow
      id="worker"
      icon={<Activity size={15} />}
      title="Implementation worker"
      description="Running validation"
      actions={[<Button size="xs" variant="borderless" key="stop">Stop</Button>]}
    />
  );
}
