import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { registerCanonEditor } from "@/app/canonEditGuard.ts";

type InlineOptions = {
  editing: boolean; busy: boolean; dirty: boolean; save: () => Promise<boolean>; cancel: () => void; focus: () => void;
};

export function useInlineExitGuard(options: InlineOptions) {
  const latest = useRef(options);
  latest.current = options;
  const pending = useRef<{ promise: Promise<boolean>; resolve: (leave: boolean) => void } | null>(null);
  const [open, setOpen] = useState(false);
  const pointer = useRef(false), blurred = useRef(false);
  const actions = useInlineActions(latest);
  const leave = () => {
    if (pending.current) return pending.current.promise;
    if (!latest.current.dirty) { latest.current.cancel(); return Promise.resolve(true); }
    let resolve!: (leave: boolean) => void;
    const promise = new Promise<boolean>(done => { resolve = done; });
    pending.current = { promise, resolve };
    setOpen(true);
    return promise;
  };
  const decide = async (choice: "keep" | "discard" | "save") => {
    if (choice === "save" && !await latest.current.save()) return;
    if (choice === "discard") latest.current.cancel();
    // A single user action can invoke several navigation actions before React
    // commits the closed editor. The decision already applies to all of them.
    if (choice !== "keep") latest.current = { ...latest.current, editing: false, dirty: false };
    const request = pending.current;
    pending.current = null;
    setOpen(false);
    request?.resolve(choice !== "keep");
    if (choice === "keep") latest.current.focus();
  };
  useLayoutEffect(() => {
    if (!options.editing) return;
    const unregister = registerCanonEditor({ leave });
    const down = () => { pointer.current = true; };
    const click = () => {
      pointer.current = false;
      if (blurred.current) { blurred.current = false; void leave(); }
    };
    const end = () => queueMicrotask(click);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("click", end, true);
    document.addEventListener("pointercancel", end, true);
    const unload = (event: BeforeUnloadEvent) => {
      if (latest.current.dirty) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", unload);
    return () => {
      unregister(); window.removeEventListener("beforeunload", unload);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("click", end, true);
      document.removeEventListener("pointercancel", end, true);
      pointer.current = false; blurred.current = false;
    };
  }, [options.editing]);
  useLayoutEffect(() => () => { pending.current?.resolve(false); }, []);
  const blur = () => {
    if (pointer.current) blurred.current = true;
    else void leave();
  };
  return { open, leave, decide, blur, ...actions };
}

function useInlineActions(latest: RefObject<InlineOptions>) {
  const options = latest.current;
  const action = useRef(false), restoreFocus = useRef(false);
  const [focusRequest, requestFocus] = useState(0);
  const save = async () => {
    action.current = true;
    try {
      const saved = await latest.current.save();
      if (!saved) { restoreFocus.current = true; requestFocus(value => value + 1); }
      return saved;
    } finally {
      if (restoreFocus.current) action.current = false;
    }
  };
  const cancel = () => { action.current = true; latest.current.cancel(); };
  useLayoutEffect(() => {
    if (!options.editing) action.current = false;
    if (restoreFocus.current && !options.busy && options.editing) {
      restoreFocus.current = false; latest.current.focus();
    }
  }, [options.editing, options.busy, focusRequest]);
  return { save, cancel, acting: () => action.current };
}
