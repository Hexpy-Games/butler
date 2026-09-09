import { expect, test } from "bun:test";
import { HARNESS_NAVIGATION } from "../fixtures";
import { projectSpace, spaceChildren } from "./projection";
import { canDrop, useSpaceDrag } from "./drag";

test("unchanged navigation rows and sibling lists retain identity across live revisions", () => {
  const navigation = structuredClone(HARNESS_NAVIGATION);
  const first = projectSpace(navigation);
  const next = projectSpace({ ...navigation, space: { ...navigation.space, revision: 2 } });
  expect(next.get("s:butler-client")).toBe(first.get("s:butler-client"));
  expect(spaceChildren(next, "p:butler")).toBe(spaceChildren(first, "p:butler"));
  expect(next.get("s:butler-client")?.location).toBe("butler");
  expect(next.get("s:butler-client")?.ancestors).toEqual(["p:butler"]);
  const archived = projectSpace({ ...navigation, projects: navigation.projects.map(project => ({ ...project, archived: true })) });
  expect(archived.has("s:butler-client")).toBe(false);
});

test("drag targets belong to one rendered instance and general cannot be reorganized", () => {
  const rows = projectSpace(HARNESS_NAVIGATION);
  expect(canDrop(rows, "s:general", "p:butler", "inside")).toBe(false);
  expect(canDrop(rows, "p:butler", "p:butler", "inside")).toBe(false);
  expect(canDrop(rows, "s:butler-client", null, "inside")).toBe(true);
  const drag = useSpaceDrag.getState();
  drag.start("s:butler-client", "tree-source");
  drag.over({ key: "p:butler", instance: "tree-project", position: "before" });
  expect(useSpaceDrag.getState().target?.instance).toBe("tree-project");
  expect(useSpaceDrag.getState().target?.instance === "favorite-project").toBe(false);
  drag.end();
  expect(useSpaceDrag.getState().target).toBeNull();
});
