import { useLayoutEffect, useRef, useState } from "react";
import { registerCanonEditor } from "@/app/canonEditGuard.ts";

export function useInlineExitGuard(options: {
  editing: boolean; dirty: boolean; save: () => Promise<boolean>; cancel: () => void; focus: () => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const pending = useRef<{ promise: Promise<boolean>; resolve: (leave: boolean) => void } | null>(null);
  const [open, setOpen] = useState(false);
  const pointer = useRef(false), blurred = useRef(false);
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
  return { open, leave, decide, blur };
}
