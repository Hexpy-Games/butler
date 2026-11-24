import { useState } from "react";
import type { ComputerModelSource, MainModelKind } from "../computerTypes";

export const COMPUTER_MODEL_CHOICES = ["follow", "key", "chatgpt", "none"] as const;
export type ComputerModelChoice = typeof COMPUTER_MODEL_CHOICES[number];

export function defaultSource(main: MainModelKind): ComputerModelSource {
  return main === "key" ? "follow" : main;
}

export function useComputerModelChoice(initial: ComputerModelSource) {
  const [choice, setChoice] = useState<ComputerModelChoice>(typeof initial === "string" ? initial : "key");
  const [keyId, setKeyId] = useState(typeof initial === "string" ? "" : initial.key);

  function reset(source: ComputerModelSource) {
    setChoice(typeof source === "string" ? source : "key");
    setKeyId(typeof source === "string" ? "" : source.key);
  }

  const source: ComputerModelSource = choice === "key" ? { key: keyId } : choice;
  const ready = choice !== "key" || keyId !== "";
  return { choice, keyId, setChoice, setKeyId, reset, source, ready };
}
