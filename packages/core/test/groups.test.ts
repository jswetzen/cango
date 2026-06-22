import { describe, expect, it } from "vitest";
import { expandGroups } from "../src/groups.js";
import type { FamilyGraph, Group } from "../src/types.js";

function family(groups: Group[]): FamilyGraph {
  return { people: [], organizations: [], sources: [], groups };
}

describe("expandGroups", () => {
  it("returns plain person ids unchanged", () => {
    expect(expandGroups(["a", "b"], family([]))).toEqual(["a", "b"]);
  });

  it("expands a group to its members", () => {
    const f = family([{ id: "fam", name: "Fam", memberIds: ["a", "b", "c"] }]);
    expect(expandGroups(["fam"], f)).toEqual(["a", "b", "c"]);
  });

  it("expands nested groups transitively", () => {
    const f = family([
      { id: "kids", name: "Kids", memberIds: ["eli", "jona"] },
      { id: "fam", name: "Fam", memberIds: ["johan", "kids"] },
    ]);
    expect(expandGroups(["fam"], f)).toEqual(["johan", "eli", "jona"]);
  });

  it("dedups across overlapping inputs, order by first appearance", () => {
    const f = family([{ id: "g", name: "G", memberIds: ["a", "b"] }]);
    expect(expandGroups(["a", "g", "b"], f)).toEqual(["a", "b"]);
  });

  it("is cycle-safe", () => {
    const f = family([
      { id: "x", name: "X", memberIds: ["y", "a"] },
      { id: "y", name: "Y", memberIds: ["x", "b"] },
    ]);
    expect(expandGroups(["x"], f)).toEqual(["b", "a"]);
  });

  it("keeps unknown leaf ids (they may be people the graph doesn't enumerate)", () => {
    expect(expandGroups(["ghost"], family([]))).toEqual(["ghost"]);
  });
});
