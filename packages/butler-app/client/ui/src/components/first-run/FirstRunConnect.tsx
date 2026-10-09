import { FirstRunCustomServer } from "./FirstRunCustomServer";
import { FirstRunKeyForm } from "./FirstRunKeyForm";
import { FirstRunModelPicker } from "./FirstRunModelPicker";
import { FirstRunProviderList } from "./FirstRunProviderList";
import { FirstRunSignIn } from "./FirstRunSignIn";
import type { FirstRunFlow } from "./useFirstRunFlow";

/** Existing connection options; every settled connection moves to the ready step. */
export function FirstRunConnect({ flow }: { flow: FirstRunFlow }) {
  const { copy, view } = flow;
  return view.kind === "list" ? <FirstRunProviderList flow={flow} />
    : view.kind === "signin" ? <FirstRunSignIn flow={flow} />
      : view.kind === "key" ? <FirstRunKeyForm cardId={view.cardId} flow={flow} key={view.cardId} />
        : view.kind === "local" ? (
          <FirstRunModelPicker body={copy.localBody} cardId="local" flow={flow} options={flow.local.options} title={copy.localTitle} />
        ) : view.kind === "custom" ? <FirstRunCustomServer flow={flow} />
          : <FirstRunModelPicker apiKey={view.apiKey} cardId="other" flow={flow} options={view.options} title={copy.customTitle} />;
}
