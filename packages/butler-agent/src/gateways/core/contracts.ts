export type SessionRole = "butler" | "steward" | "worker";
export type ModelRef = `${string}/${string}`;
export type PromptCacheRetention = "in_memory" | "24h";

export interface AttachmentRef {
  id: string;
  kind: "image" | "audio" | "video" | "document" | "binary";
  mimeType?: string;
  fileName?: string;
  sizeBytes?: number;
  url?: string;
  localPath?: string;
  metadata?: Record<string, unknown>;
}

export interface ArtifactRef {
  id: string;
  kind:
    | "csv_file"
    | "table_file"
    | "chart_file"
    | "image"
    | "document"
    | "code"
    | "report"
    | "file"
    | "unknown";
  title: string;
  safePathLabel?: string;
  mimeType?: string;
  localPath?: string;
  url?: string;
  sizeBytes?: number;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface InboundEnvelope {
  eventId: string;
  signal?: AbortSignal;
  transport: string;
  accountId: string;
  peer: {
    kind: "dm" | "group" | "thread" | "channel";
    id: string;
    parentId?: string;
  };
  sender: {
    id: string;
    displayName?: string;
  };
  message: {
    id: string;
    text?: string;
    attachments?: AttachmentRef[];
    timestamp: string;
  };
  routingHints?: {
    sessionId?: string;
    projectId?: string;
    stewardId?: string;
    turnId?: string;
  };
  raw?: unknown;
}

export interface OutboundAction {
  actionId: string;
  transport: string;
  accountId: string;
  peer: {
    kind: "dm" | "group" | "thread" | "channel";
    id: string;
    threadId?: string;
  };
  message: {
    text?: string;
    attachments?: AttachmentRef[];
    artifacts?: ArtifactRef[];
    replyToMessageId?: string;
    editMessageId?: string;
  };
  presence?: {
    kind: "typing";
  };
  metadata?: Record<string, unknown>;
}

export interface DeliveryResult {
  ok: boolean;
  transportMessageId?: string;
  raw?: unknown;
  error?: string;
}

export interface TransportCapabilities {
  supportsThreads: boolean;
  supportsMessageEdit: boolean;
  supportsReactions: boolean;
  supportsAttachments: boolean;
  supportsStreamingEdits: boolean;
  supportsPresence: boolean;
  supportsActivityEvents?: boolean;
  supportsArtifactViewer?: boolean;
  supportsProgressDrafts?: boolean;
  supportsFinalAggregateOnly?: boolean;
}

export interface TransportAdapter {
  id: string;
  capabilities: TransportCapabilities;
  start(onEvent: (event: InboundEnvelope) => Promise<void>): Promise<void>;
  send(action: OutboundAction): Promise<DeliveryResult>;
}

export type GatewayDurableRole = Exclude<SessionRole, "worker">;
export type GatewayRouteReason =
  | "session-hint"
  | "steward-hint"
  | "project-hint"
  | "transport-binding"
  | "app-worker-result"
  | "app-planned-worker-review"
  | "butler-fallback";

export interface GatewayRoute {
  sessionId: string;
  role: GatewayDurableRole;
  reason: GatewayRouteReason;
  workspacePath: string;
  projectId?: string;
}

export interface GatewayUnroutableDetails {
  transport: string;
  accountId: string;
  peerId: string;
  threadId?: string;
  sessionId?: string;
  projectId?: string;
  stewardId?: string;
}

export interface GatewayRoutedResult {
  status: "routed";
  route: GatewayRoute;
}

export interface GatewayUnroutableResult {
  status: "unroutable";
  reason: "missing-session";
  details: GatewayUnroutableDetails;
}

export type GatewayRouteResult = GatewayRoutedResult | GatewayUnroutableResult;

export interface GatewayRouterLike {
  routeInbound(envelope: InboundEnvelope): GatewayRouteResult;
}

export interface GatewayHandlerInput {
  envelope: InboundEnvelope;
  route: GatewayRoute;
}

export interface GatewayHandlerResult {
  ok: boolean;
  handledBy?: string;
  metadata?: Record<string, unknown>;
}

export type GatewayRoleHandler = (input: GatewayHandlerInput) => Promise<GatewayHandlerResult>;

export interface GatewayRoleHandlers {
  butler?: GatewayRoleHandler;
  steward?: GatewayRoleHandler;
}

export interface GatewayHandledResult {
  status: "handled";
  route: GatewayRoute;
  handlerResult: GatewayHandlerResult;
}

export interface GatewayMissingHandlerResult {
  status: "missing-handler";
  route: GatewayRoute;
}

export type GatewayDispatchResult =
  | GatewayHandledResult
  | GatewayMissingHandlerResult
  | GatewayUnroutableResult;

export interface GatewayActorTurnResult {
  text: string;
  deliveries?: OutboundAction[];
  artifacts?: ArtifactRef[];
  generatedSessionTitle?: string | null;
  loadedSkillNames?: string[];
  providerThreadRef?: string;
  runtimeSessionRef?: string;
  raw?: unknown;
}

export interface GatewaySessionActor {
  readonly sessionId: string;
  readonly role: GatewayDurableRole;
  handleInbound(envelope: InboundEnvelope, route?: GatewayRoute): Promise<GatewayActorTurnResult>;
  close(reason?: string): Promise<void>;
}
