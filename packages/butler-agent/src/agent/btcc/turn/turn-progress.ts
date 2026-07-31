import type { BtccTurnProgressObserver } from "../contracts.ts";

export async function publishOperationalNotice(
  observer: BtccTurnProgressObserver | undefined,
  update: Parameters<NonNullable<
    BtccTurnProgressObserver["operationalNoticeChanged"]
  >>[0],
): Promise<void> {
  if (!observer?.operationalNoticeChanged) return;
  try {
    await observer.operationalNoticeChanged(update);
  } catch {
    // Public progress cannot veto durable Turn state.
  }
}
