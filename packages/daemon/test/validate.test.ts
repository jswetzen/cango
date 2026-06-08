import { describe, expect, test } from "bun:test";
import { checkReferences, familyFileSchema, type FamilyFile } from "../src/config.ts";

/** A schema-valid family with one person, one org-owned source, one attendance. */
function baseFamily(): FamilyFile {
  return familyFileSchema.parse({
    people: [{ id: "p-me", name: "Me", sourceIds: ["src-work"] }],
    organizations: [{ id: "org-club", name: "Club", sourceIds: ["src-club"] }],
    sources: [
      { id: "src-work", kind: "ics", ownedBy: "person", ownerId: "p-me", url: "https://x/w.ics" },
      {
        id: "src-club",
        kind: "ics",
        ownedBy: "organization",
        ownerId: "p-me",
        url: "https://x/c.ics",
      },
    ],
    attendance: [{ personId: "p-me", seriesId: "s1", role: "ATTENDS" }],
  });
}

function paths(family: FamilyFile): string[] {
  return checkReferences(family).map((i) => i.path);
}

describe("checkReferences", () => {
  test("clean config reports nothing", () => {
    expect(checkReferences(baseFamily())).toEqual([]);
  });

  test("dangling sourceId on a person is reported", () => {
    const f = baseFamily();
    f.people[0]!.sourceIds = ["src-typo"];
    expect(paths(f)).toContain("people[0].sourceIds[0]");
  });

  test("person-owned source with unknown ownerId is reported", () => {
    const f = baseFamily();
    f.sources[0]!.ownerId = "p-ghost";
    expect(paths(f)).toContain("sources[0].ownerId");
  });

  test("org-owned source ownerId must be a person", () => {
    const f = baseFamily();
    f.sources[1]!.ownerId = "org-club"; // org id, not a person
    expect(paths(f)).toContain("sources[1].ownerId");
  });

  test("duplicate id across people and sources is reported", () => {
    const f = baseFamily();
    f.sources[0]!.id = "p-me";
    const msgs = checkReferences(f);
    expect(msgs.some((i) => /duplicate id "p-me"/.test(i.message))).toBe(true);
  });

  test("attendance personId must exist (still validated for the seed import)", () => {
    const f = baseFamily();
    f.attendance[0]!.personId = "p-nobody";
    expect(paths(f)).toContain("attendance[0].personId");
  });
});

describe("schema failures (sanity)", () => {
  test("missing kind fails familyFileSchema", () => {
    const result = familyFileSchema.safeParse({
      sources: [{ id: "s", ownedBy: "person", ownerId: "p" }],
    });
    expect(result.success).toBe(false);
  });
});
