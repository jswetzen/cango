import { describe, expect, test } from "bun:test";
import {
  checkReferences,
  familyFileSchema,
  rulesFileSchema,
  type FamilyFile,
  type RulesFile,
} from "../src/config.ts";

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

const noRules: RulesFile = rulesFileSchema.parse({ rules: [] });

function paths(family: FamilyFile, rules: RulesFile = noRules): string[] {
  return checkReferences(family, rules).map((i) => i.path);
}

describe("checkReferences", () => {
  test("clean config reports nothing", () => {
    expect(checkReferences(baseFamily(), noRules)).toEqual([]);
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
    const msgs = checkReferences(f, noRules);
    expect(msgs.some((i) => /duplicate id "p-me"/.test(i.message))).toBe(true);
  });

  test("attendance personId must exist", () => {
    const f = baseFamily();
    f.attendance[0]!.personId = "p-nobody";
    expect(paths(f)).toContain("attendance[0].personId");
  });

  test("invalid titleRegex is reported against rules", () => {
    const rules = rulesFileSchema.parse({
      rules: [{ match: { titleRegex: "(unterminated" }, role: "soft", reason: "x" }],
    });
    const issues = checkReferences(baseFamily(), rules);
    expect(issues.some((i) => i.file === "rules" && /invalid regex/.test(i.message))).toBe(true);
  });

  test("rule sourceId referencing unknown source is reported", () => {
    const rules = rulesFileSchema.parse({
      rules: [{ match: { sourceId: "src-nope" }, role: "soft", reason: "x" }],
    });
    expect(checkReferences(baseFamily(), rules).map((i) => i.path)).toContain(
      "rules[0].match.sourceId",
    );
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
