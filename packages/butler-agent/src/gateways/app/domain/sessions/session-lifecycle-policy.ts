import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";

/** Identity, not the user-editable title, determines the permanent channel. */
export function assertSessionCanClose(sessionId: string): void {
  if (sessionId === "general") {
    throw new AppStoreOperationError(
      409,
      "general_channel_protected",
      "일반 채널은 보관하거나 삭제할 수 없습니다.",
    );
  }
}
