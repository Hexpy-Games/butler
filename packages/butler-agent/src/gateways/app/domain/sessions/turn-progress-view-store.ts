import { turnFromRow } from "./message-read-model.ts";
import type { TurnRow } from "../../infrastructure/core/records.ts";
import {
  isPublicSuppressedInternalContinuationCode,
  publicAppDeliveryMetadata,
  publicDeliveryMetadataForProjection,
  publicDeliveryStateForTurnState,
  publicTurnRecord,
  publicTurnStatusLabel,
} from "../../infrastructure/transport/btcc-public-projection.ts";
import { progressRowsForTurnState } from "../progress-summary/public-progress-rows.ts";
import type { DeliveryLimitationMetadata } from "../../infrastructure/transport/app-delivery-projection.ts";
import type {
  MessageRecord,
  ProgressSummaryRow,
  SessionViewTurn,
  TurnProgressSnapshotView,
  TurnRecord,
} from "../../interface/protocol/app-protocol.ts";
import { subsessionResultStatusLabel } from "../../../core/turn-execution-controls.ts";

export class AppTurnProgressViewStore {
  constructor(
    private readonly input: {
      getTurnRow: (turnId: string) => TurnRow | null;
      listProgressRowsForTurn: (turnId: string) => ProgressSummaryRow[];
      deliveryMetadataForTurnRecord: (
        turn: TurnRecord,
      ) => DeliveryLimitationMetadata;
    },
  ) {}

  listForMessages(
    messages: MessageRecord[],
  ): Record<string, TurnProgressSnapshotView> {
    const turnIds = [
      ...new Set(
        messages
          .map((message) => message.turn_id)
          .filter((turnId): turnId is string => Boolean(turnId)),
      ),
    ];
    const snapshots: Record<string, TurnProgressSnapshotView> = {};
    for (const turnId of turnIds) {
      const turn = this.input.getTurnRow(turnId);
      if (!turn) continue;
      const publicTurn = publicTurnRecord(turnFromRow(turn));
      const rows = progressRowsForTurnState(
        this.input.listProgressRowsForTurn(turnId),
        turn.state,
      );
      const summary = publicTurnStatusLabel(
        turn.safe_status_label,
        turn.state,
        turn.safe_error_code,
      );
      const delivery = isPublicSuppressedInternalContinuationCode(
        turn.safe_error_code,
      )
        ? {
            delivery_state: publicDeliveryStateForTurnState(publicTurn.state),
            limitations: [],
            limitation_codes: [],
          }
        : publicDeliveryMetadataForProjection(
            this.input.deliveryMetadataForTurnRecord(publicTurn),
          );
      snapshots[turnId] = {
        turn_id: turnId,
        ...(summary ? { summary } : {}),
        updated_at: turn.updated_at,
        state: publicTurn.state,
        ...publicAppDeliveryMetadata(delivery),
        safe_progress_rows: rows,
      };
    }
    return snapshots;
  }

  sessionViewTurn(
    turn: TurnRecord,
    options: { suppressProgressRows?: boolean } = {},
  ): SessionViewTurn {
    const delivery = publicAppDeliveryMetadata(
      publicDeliveryMetadataForProjection(
        this.input.deliveryMetadataForTurnRecord(turn),
      ),
    );
    const rawProgressRows = options.suppressProgressRows
      ? []
      : progressRowsForTurnState(
          this.input.listProgressRowsForTurn(turn.id),
          turn.state,
        );
    const synthesis = turn.execution_controls?.subsession_result;
    const progressRows = synthesis
      ? rawProgressRows.map((row) => row.kind === "message" && !row.safe_tool_name
        ? { ...row, safe_label: subsessionResultStatusLabel(synthesis) }
        : row)
      : rawProgressRows;
    const progressSummary = publicTurnStatusLabel(
      turn.safe_status_label,
      turn.state,
    );
    return {
      id: turn.id,
      state: turn.state,
      delivery_state: delivery.delivery_state,
      limitations: delivery.limitations,
      limitation_codes: delivery.limitation_codes,
      safe_status_label: progressSummary,
      cancellable: turn.cancellable,
      retryable: turn.retryable,
      progress: {
        turn_id: turn.id,
        ...(progressSummary ? { summary: progressSummary } : {}),
        updated_at: turn.updated_at,
        state: turn.state,
        delivery_state: delivery.delivery_state,
        limitations: delivery.limitations,
        limitation_codes: delivery.limitation_codes,
        safe_progress_rows: progressRows,
      },
      created_at: turn.created_at,
      updated_at: turn.updated_at,
      execution_controls: turn.execution_controls
        ? {
            model_ref: turn.execution_controls.model_ref,
            reasoning_effort: turn.execution_controls.reasoning_effort,
            source: turn.execution_controls.source,
            ...(turn.execution_controls.subsession_result
              ? { subsession_result: turn.execution_controls.subsession_result }
              : {}),
          }
        : undefined,
      execution_model: turn.execution_model,
    };
  }
}
