import { appCopy, useAppLocale } from "@/app/copy.ts";
import { Blocks, CircleAlert, ICON_SIZE, LoadingIndicator, OverflowActionMenu, Play, StepSortableList, Trash2, Typo, type StepSortableRowContext } from "@/butler-ds";
import { acceptsOrderEdit, orderChains, type OrderItem } from "./canonOrderModel.ts";
import type { useSessionCanonQueue } from "./useSessionCanonQueue.ts";

export function StepOrderSection({ order }: { order: ReturnType<typeof useSessionCanonQueue> }) {
  useAppLocale();
  const copy = appCopy.canon.order;
  const view = order.view;
  if (!view) return null;
  const live = view.chains.filter(chain => chain.steps.some(step => step.items.some(item => item.state !== "done")));
  const chains = orderChains(view).filter(chain => live.some(item => item.chain_id === chain.id)).map(chain => {
    const origin = live.find(item => item.chain_id === chain.id)!.origin;
    return { ...chain, label: copy.chain[origin], title: live.length > 1 ? copy.chain[origin] : undefined };
  });
  const renderItem = (item: OrderItem, place: StepSortableRowContext) => {
    const epic = item.epic;
    const status = epic.hold_reason && epic.state === "running" ? "failed" : epic.state;
    const previous = chains.find(chain => chain.id === place.chainId)?.steps[place.stepIndex - 1];
    const after = previous && (previous.length > 1 ? copy.afterStack(previous[0]!.label, previous.length - 1) : copy.after(previous[0]!.label));
    const progress = epic.progress;
    const activity = progress.actions.find(action => action.status === "active")?.description;
    const caption = activity || (progress.counts.total > 0 ? appCopy.canon.done(progress.counts.completed, progress.counts.total) : undefined)
      || (epic.held_by_epic_id ? copy.heldBy : after);
    return {
      marker: <OrderMarker status={status} number={place.stepNumber} />,
      title: item.label, meta: status === "waiting" ? undefined : copy.status[status],
      more: place.count > 1 && !place.expanded ? copy.more(place.count - 1) : undefined,
      caption: place.lifted && place.outcome ? (place.outcome === "join" ? copy.join : copy.newStep) : caption,
      trailing: item.pinned || order.busy ? undefined : <OverflowActionMenu label={copy.menu(item.label)} items={[
        { icon: <Play size="sm" />, label: copy.startNow, onSelect: () => { void order.edit({ action: "startNow", epicId: item.id }); } },
        ...(place.count > 1 ? [{ icon: <Blocks size="sm" />, label: copy.unstack, onSelect: () => { void order.edit({ action: "unstack", epicId: item.id }); } }] : []),
        { icon: <Trash2 size="sm" />, label: copy.remove, variant: "destructive", onSelect: () => { void order.edit({ action: "remove", epicId: item.id }); } },
      ]} />,
    };
  };
  return <StepSortableList chains={chains} canDrop={edit => acceptsOrderEdit(view, edit)} renderItem={renderItem} disabled={order.busy}
    onEdit={edit => { void order.edit(edit); }} labels={copy.drag} deckLabels={copy.deck} />;
}
function OrderMarker({ status, number }: { status: string; number: number }) {
  if (status === "running" || status === "done") return <LoadingIndicator state={status === "done" ? "done" : "loading"} size={ICON_SIZE.md} />;
  if (status === "failed") return <Typo.Text tone="danger"><CircleAlert size="md" /></Typo.Text>;
  return <Typo.Label tone="tertiary" numeric="tabular">{number}</Typo.Label>;
}
