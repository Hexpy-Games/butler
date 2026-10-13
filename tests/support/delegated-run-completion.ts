type Child = {
  terminal?: boolean;
  result?: unknown;
  relation: { relation_id: string };
};

type SessionView = {
  active_turn?: unknown;
  latest_turn?: { state: string };
  steward_children?: Child[];
  messages: Array<{ role: string; status: string; turn_id: string; text: string; answer_blocks?: unknown[] }>;
};

export type ResultDelivery = {
  relation_id: string;
  status: string;
  turn_id: string | null;
};

/** A parent's delegation acknowledgement is not the delegated final answer. */
export function delegatedRunComplete(view: SessionView, deliveries: ResultDelivery[]): boolean {
  if (view.active_turn || view.latest_turn?.state !== "delivered") return false;
  const children = view.steward_children ?? [];
  if (children.length === 0) return false;
  return children.every(child => {
    if (!child.terminal || !child.result) return false;
    return deliveries.some(delivery => delivery.relation_id === child.relation.relation_id
      && delivery.status === "delivered"
      && view.messages.some(message => message.turn_id === delivery.turn_id
        && message.role === "assistant" && message.status === "delivered"
        && (message.text.trim().length > 0 || Boolean(message.answer_blocks?.length))));
  });
}
