import type { Database } from "bun:sqlite";
import type {
  ModelRouteEventResult,
  ModelRouteState,
} from "../../../btcc/model-route/index.ts";
import type { ModelRoundResult } from "../../../btcc/ports/index.ts";
import { SqliteModelRouteAcceptanceStore } from "./sqlite-model-route-acceptance-store.ts";
import { SqliteModelRouteEventJournal } from "./sqlite-model-route-event-journal.ts";
import type {
  SqliteModelRouteAttemptHistoryInput,
  SqliteModelRouteEventInput,
  SqliteModelRoundAcceptanceInput,
} from "./sqlite-model-route-types.ts";

/**
 * Public adapter boundary for the Turn-owned model route. Event journaling and
 * accepted-response storage remain separate owners, but callers receive one
 * cohesive route persistence port.
 */
export class SqliteModelRouteRepository {
  private readonly events: SqliteModelRouteEventJournal;
  private readonly acceptances: SqliteModelRouteAcceptanceStore;

  constructor(db: Database) {
    this.events = new SqliteModelRouteEventJournal(db);
    this.acceptances = new SqliteModelRouteAcceptanceStore(db);
  }

  persistModelRoute(input: {
    turnId: string;
    expectedRevision: number;
    executionFence: number;
    claimId: string;
    route: ModelRouteState;
  }): Promise<void> {
    return this.events.persistModelRoute(input);
  }

  recordModelRouteEvent(
    input: SqliteModelRouteEventInput,
  ): Promise<ModelRouteEventResult> {
    return this.events.recordModelRouteEvent(input);
  }

  loadModelRouteAttemptHistory(
    input: SqliteModelRouteAttemptHistoryInput,
  ) {
    return this.events.loadModelRouteAttemptHistory(input);
  }

  loadModelRoundAcceptance(input: {
    turnId: string;
    roundId: string;
    routeDigest: string;
    candidateIndex: number;
    modelRef: string;
    checkpointId: string;
    checkpointRevision: number;
  }): Promise<ModelRoundResult | undefined> {
    return this.acceptances.loadModelRoundAcceptance(input);
  }

  recordModelRoundAcceptance(input: SqliteModelRoundAcceptanceInput): Promise<void> {
    return this.acceptances.recordModelRoundAcceptance(input);
  }
}
