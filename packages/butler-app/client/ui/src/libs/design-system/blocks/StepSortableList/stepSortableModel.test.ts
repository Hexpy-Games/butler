// test-category: pure-logic
/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import {
  applyStepSortableEdit, editFor, keyboardTargets, resultPlace,
  type StepSortableChain, type StepSortableItem, type StepSortableTarget,
} from "./stepSortableModel";

const item = (id: string, extra: Partial<StepSortableItem> = {}): StepSortableItem => ({ id, label: id.toUpperCase(), ...extra });
// main: a → (b, c) → d; side: e
const CHAINS: StepSortableChain[] = [
  { id: "main", label: "Main", steps: [[item("a")], [item("b"), item("c")], [item("d")]] },
  { id: "side", label: "Side", steps: [[item("e")]] },
];
const ids = (chains: StepSortableChain[]) => chains.map((chain) => chain.steps.map((step) => step.map((entry) => entry.id).join("+")).join(" → "));
const gap = (chainId: string, stepIndex: number): StepSortableTarget => ({ chainId, stepIndex, kind: "gap" });
const join = (chainId: string, stepIndex: number): StepSortableTarget => ({ chainId, stepIndex, kind: "join" });
const apply = (itemIds: string[], target: StepSortableTarget, chains = CHAINS) => {
  const edit = editFor(chains, itemIds, target);
  return edit ? { type: edit.type, chains: ids(applyStepSortableEdit(chains, edit)) } : null;
};

describe("editFor and applyStepSortableEdit", () => {
  test("a gap makes a new step; the gaps around a single item's own step change nothing", () => {
    expect(apply(["a"], gap("main", 3))).toEqual({ type: "move_to_new_step", chains: ["b+c → d → a", "e"] });
    expect(apply(["d"], gap("main", 0))).toEqual({ type: "move_to_new_step", chains: ["d → a → b+c", "e"] });
    expect(apply(["a"], gap("main", 0))).toBeNull();
    expect(apply(["a"], gap("main", 1))).toBeNull();
  });

  test("joining a step adds the item to its 묶음, flat; joining its own step changes nothing", () => {
    expect(apply(["a"], join("main", 2))).toEqual({ type: "join_stack", chains: ["b+c → d+a", "e"] });
    expect(apply(["d"], join("main", 1))).toEqual({ type: "join_stack", chains: ["a → b+c+d", "e"] });
    expect(apply(["a"], join("main", 0))).toBeNull();
  });

  test("leaving a 묶음 for a gap splits it, also right before or after its own step", () => {
    expect(apply(["c"], gap("main", 1))).toEqual({ type: "split_stack", chains: ["a → c → b → d", "e"] });
    expect(apply(["c"], gap("main", 2))).toEqual({ type: "split_stack", chains: ["a → b → c → d", "e"] });
    expect(apply(["b"], join("main", 0))).toEqual({ type: "join_stack", chains: ["a+b → c → d", "e"] });
  });

  test("a whole 묶음 moves as one step, and merging it into a step stays flat", () => {
    expect(apply(["b", "c"], gap("main", 3))).toEqual({ type: "move_to_new_step", chains: ["a → d → b+c", "e"] });
    expect(apply(["b", "c"], gap("main", 2))).toBeNull();
    expect(apply(["b", "c"], join("main", 2))).toEqual({ type: "join_stack", chains: ["a → d+b+c", "e"] });
    expect(apply(["b", "c"], gap("side", 0))).toEqual({ type: "move_between", chains: ["a → d", "b+c → e"] });
  });

  test("another chain: a new step or a join, reported with both places before the edit", () => {
    const edit = editFor(CHAINS, ["a"], gap("side", 1));
    expect(edit).toEqual({ type: "move_between", itemIds: ["a"], from: { chainId: "main", stepIndex: 0 }, to: { chainId: "side", stepIndex: 1 }, placement: "new_step" });
    expect(ids(applyStepSortableEdit(CHAINS, edit!))).toEqual(["b+c → d", "e → a"]);
    expect(apply(["c"], join("side", 0))).toEqual({ type: "move_between", chains: ["a → b → d", "e+c"] });
  });

  test("a running head is pinned: nothing joins it or goes before it", () => {
    const chains: StepSortableChain[] = [{ id: "main", label: "Main", steps: [[item("a", { running: true })], [item("b")], [item("c")]] }];
    expect(apply(["c"], join("main", 0), chains)).toBeNull();
    expect(apply(["c"], gap("main", 0), chains)).toBeNull();
    expect(apply(["c"], gap("main", 1), chains)).toEqual({ type: "move_to_new_step", chains: ["a → c → b"] });
  });

  test("targets outside a chain are refused and the input is never mutated", () => {
    expect(apply(["a"], gap("main", 9))).toBeNull();
    expect(apply(["a"], join("side", 1))).toBeNull();
    expect(apply(["zz"], gap("main", 0))).toBeNull();
    expect(apply(["a", "d"], gap("side", 0))).toBeNull();
    expect(ids(CHAINS)).toEqual(["a → b+c → d", "e"]);
  });
});

describe("keyboard targets and announcements", () => {
  test("each chain lists the gap before every step, the step itself, and the gap after the last", () => {
    const keys = keyboardTargets(CHAINS).map((target) => `${target.chainId}:${target.kind}${target.stepIndex}`);
    expect(keys).toEqual(["main:gap0", "main:join0", "main:gap1", "main:join1", "main:gap2", "main:join2", "main:gap3", "side:gap0", "side:join0", "side:gap1"]);
  });

  test("the announced step is the items' step number after the move", () => {
    expect(resultPlace(CHAINS, editFor(CHAINS, ["a"], gap("main", 3))!)).toEqual({ chain: "Main", step: 3 });
    expect(resultPlace(CHAINS, editFor(CHAINS, ["d"], join("main", 1))!)).toEqual({ chain: "Main", step: 2 });
    expect(resultPlace(CHAINS, editFor(CHAINS, ["c"], gap("side", 0))!)).toEqual({ chain: "Side", step: 1 });
  });
});
