import { describe, expect, test } from "bun:test";
import {
  indexTaskGraph, laneTaskGraph, layoutTaskGraph, rollupTaskGraphStatus, taskGraphEdgeState, taskGraphRanks,
} from "./taskGraphLayout";

const ids = (column: { id: string }[]) => column.map((slot) => slot.id);

describe("task graph layout", () => {
  test("ranks are the longest path from a source", () => {
    const index = indexTaskGraph(["a", "b", "c", "d"], [
      { from: "a", to: "b" }, { from: "b", to: "c" }, { from: "a", to: "c" }, { from: "c", to: "d" },
    ]);
    expect(Object.fromEntries(taskGraphRanks(index))).toEqual({ a: 0, b: 1, c: 2, d: 3 });
  });

  test("fan-out and join keep three parallel tasks in one column", () => {
    const index = indexTaskGraph(["s", "x", "y", "z", "j"], [
      { from: "s", to: "x" }, { from: "s", to: "y" }, { from: "s", to: "z" },
      { from: "x", to: "j" }, { from: "y", to: "j" }, { from: "z", to: "j" },
    ]);
    expect(layoutTaskGraph(index).columns.map(ids)).toEqual([["s"], ["x", "y", "z"], ["j"]]);
  });

  test("a rank-skipping edge is routed through one dummy per skipped column", () => {
    const index = indexTaskGraph(["a", "b", "c"], [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "a", to: "c" }]);
    const layout = layoutTaskGraph(index);
    expect(layout.columns.map(ids)).toEqual([["a"], ["b", "a->c#1"], ["c"]]);
    expect(layout.routes.get("a->c")).toEqual(["a", "a->c#1", "c"]);
  });

  test("barycentre ordering follows the predecessors' order", () => {
    const index = indexTaskGraph(["p", "q", "b", "a"], [{ from: "p", to: "a" }, { from: "q", to: "b" }]);
    expect(layoutTaskGraph(index).columns.map(ids)).toEqual([["p", "q"], ["a", "b"]]);
  });

  test("cycles, self-edges and unknown endpoints do not hang or throw", () => {
    const index = indexTaskGraph(["a", "b"], [{ from: "a", to: "b" }, { from: "b", to: "a" }, { from: "a", to: "a" }, { from: "a", to: "zz" }]);
    expect(layoutTaskGraph(index).columns.flat().length).toBe(2);
  });

  test("lanes: fan-out opens one lane per branch and the join closes them", () => {
    const index = indexTaskGraph(["s", "x", "y", "j"], [
      { from: "s", to: "x" }, { from: "s", to: "y" }, { from: "x", to: "j" }, { from: "y", to: "j" },
    ]);
    const lanes = laneTaskGraph(layoutTaskGraph(index), index);
    expect(lanes.rows).toEqual(["s", "x", "y", "j"]);
    expect(Object.fromEntries(lanes.lane)).toEqual({ s: 0, x: 0, y: 1, j: 0 });
    expect(lanes.laneCount).toBe(2);
  });

  test("a 2,000-task chain with skips lays out in well under a frame budget", () => {
    const n = 2000;
    const nodes = Array.from({ length: n }, (_, i) => `t${i}`);
    const edges = nodes.slice(1).map((id, i) => ({ from: nodes[i]!, to: id }));
    for (let i = 0; i + 3 < n; i += 50) edges.push({ from: nodes[i]!, to: nodes[i + 3]! });
    const run = () => {
      const index = indexTaskGraph(nodes, edges);
      return laneTaskGraph(layoutTaskGraph(index), index);
    };
    run(); // warm the JIT; the budget is for steady state (a few ms locally)
    const started = performance.now();
    expect(run().rows.length).toBe(n);
    expect(performance.now() - started).toBeLessThan(250);
  });

  test("edge state and graph rollup", () => {
    expect(taskGraphEdgeState("done", "running")).toBe("active");
    expect(taskGraphEdgeState("done", "pending")).toBe("satisfied");
    expect(taskGraphEdgeState("running", "pending")).toBe("waiting");
    expect(taskGraphEdgeState("cancelled", "pending")).toBe("failed");
    expect(rollupTaskGraphStatus(["done", "running", "failed"])).toBe("running");
    expect(rollupTaskGraphStatus(["done", "failed", "pending"])).toBe("failed");
    expect(rollupTaskGraphStatus(["done", "done"])).toBe("done");
    expect(rollupTaskGraphStatus(["done", "pending"])).toBe("pending");
    expect(rollupTaskGraphStatus(["done", "cancelled"])).toBe("cancelled");
  });
});
