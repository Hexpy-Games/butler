import { describe, expect, test } from "bun:test";
import { initialItems } from "./sample-data";
import { groupSessions, moveTreeItem } from "./tree-move";

describe("sidebar mockup tree movements", () => {
  test("center drop groups sessions at target location without changing other records", () => {
    const grouped = groupSessions(
      initialItems,
      "kyoto",
      "insurance",
      "new-group",
    )!;
    expect(grouped.find((item) => item.id === "new-group")).toEqual({
      id: "new-group",
      title: "새 그룹",
      kind: "group",
      parent: "health",
    });
    expect(
      grouped
        .filter((item) => item.parent === "new-group")
        .map((item) => item.id),
    ).toEqual(["insurance", "kyoto"]);
    expect(
      grouped.filter(
        (item) => !["insurance", "kyoto", "new-group"].includes(item.id),
      ),
    ).toEqual(
      initialItems.filter((item) => !["insurance", "kyoto"].includes(item.id)),
    );
    expect(initialItems.find((item) => item.id === "kyoto")?.parent).toBeNull();
  });
  test("grouping preserves project boundaries and requires two different sessions", () => {
    expect(
      groupSessions(initialItems, "insurance", "insurance", "group"),
    ).toBeNull();
    expect(
      groupSessions(initialItems, "health", "insurance", "group"),
    ).toBeNull();
    expect(groupSessions(initialItems, "kyoto", "oauth", "group")).toBeNull();
    const items = [
      ...initialItems,
      {
        id: "other",
        title: "Other",
        kind: "session" as const,
        parent: "sandy",
      },
    ];
    expect(
      groupSessions(items, "other", "oauth", "group")?.find(
        (item) => item.id === "group",
      )?.parent,
    ).toBe("sandy");
  });
  test("moves a session into a group and reorders among siblings", () => {
    const inside = moveTreeItem(initialItems, "kyoto", "health", "inside")!;
    expect(inside.find((item) => item.id === "kyoto")?.parent).toBe("health");
    const before = moveTreeItem(inside, "kyoto", "insurance", "before")!;
    expect(
      before.filter((item) => item.parent === "health").map((item) => item.id),
    ).toEqual(["kyoto", "insurance", "checkup"]);
  });
  test("moving a group keeps descendants and can return it to the root", () => {
    const nested = moveTreeItem(initialItems, "health", "products", "inside")!;
    expect(nested.find((item) => item.id === "insurance")?.parent).toBe(
      "health",
    );
    const root = moveTreeItem(nested, "health", null, "inside")!;
    expect(root.find((item) => item.id === "health")?.parent).toBeNull();
    expect(root).toHaveLength(initialItems.length);
  });
  test("cannot create a cycle or put a project under a project", () => {
    expect(
      moveTreeItem(initialItems, "products", "butler", "inside"),
    ).toBeNull();
    expect(
      moveTreeItem(initialItems, "products", "sandy", "inside"),
    ).toBeNull();
    expect(
      moveTreeItem(initialItems, "health", "insurance", "inside"),
    ).toBeNull();
  });
});
