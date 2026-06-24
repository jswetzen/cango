import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildFamily,
  expandConnectionEnv,
  expandEnvVars,
  familyFileSchema,
  YamlFamilySource,
} from "../src/config.ts";

describe("expandEnvVars", () => {
  test("replaces set vars and reports missing ones", () => {
    process.env.CANGO_T_SET = "secret";
    delete process.env.CANGO_T_UNSET;
    const r = expandEnvVars("a-${CANGO_T_SET}-${CANGO_T_UNSET}");
    expect(r.value).toBe("a-secret-");
    expect(r.missing).toEqual(["CANGO_T_UNSET"]);
  });

  test("leaves strings without placeholders untouched", () => {
    expect(expandEnvVars("https://caldav.example.com/")).toEqual({
      value: "https://caldav.example.com/",
      missing: [],
    });
  });
});

describe("expandConnectionEnv", () => {
  test("expands a caldav password from the environment", () => {
    process.env.CANGO_T_PW = "hunter2";
    const { connection, missing } = expandConnectionEnv({
      kind: "caldav",
      sourceId: "s",
      serverUrl: "https://x/",
      username: "u",
      password: "${CANGO_T_PW}",
      writable: false,
    });
    expect(missing).toEqual([]);
    expect(connection.kind === "caldav" && connection.password).toBe("hunter2");
  });

  test("expands and preserves an explicit calendarUrl", () => {
    process.env.CANGO_T_PW = "hunter2";
    const { connection } = expandConnectionEnv({
      kind: "caldav",
      sourceId: "s",
      serverUrl: "https://x/remote.php/dav/",
      username: "u",
      password: "${CANGO_T_PW}",
      calendarUrl: "https://x/remote.php/dav/calendars/u/personal/",
      writable: true,
    });
    expect(connection.kind === "caldav" && connection.calendarUrl).toBe(
      "https://x/remote.php/dav/calendars/u/personal/",
    );
  });
});

describe("conditional role coercion", () => {
  test("a source defaultRole: conditional in family.yaml loads as info", () => {
    // `conditional` was removed; the schema preprocessor coerces a lingering
    // value so an old family.yaml still loads rather than failing the enum.
    const file = familyFileSchema.parse({
      people: [{ id: "p-me", name: "Me", sourceIds: ["src-x"] }],
      sources: [
        {
          id: "src-x",
          kind: "ics",
          ownedBy: "person",
          ownerId: "p-me",
          url: "https://example.invalid/x.ics",
          defaultRole: "conditional",
        },
      ],
    });
    expect(file.sources[0]!.defaultRole).toBe("info");
    // And it survives into the built FamilyGraph as a concrete Role.
    const { family } = buildFamily(file);
    expect(family.sources[0]!.defaultRole).toBe("info");
  });
});

describe("YamlFamilySource env expansion", () => {
  const familyYaml = (password: string) => `
people:
  - id: p-me
    name: Me
    sourceIds: [src-dav]
sources:
  - id: src-dav
    kind: caldav
    ownedBy: person
    ownerId: p-me
    serverUrl: https://caldav.example.com/
    username: me@example.com
    password: ${password}
`;

  function withTempFamily(password: string): string {
    const dir = mkdtempSync(join(tmpdir(), "cango-cfg-"));
    const path = join(dir, "family.yaml");
    writeFileSync(path, familyYaml(password));
    return path;
  }

  test("throws when a referenced env var is unset", async () => {
    delete process.env.CANGO_T_MISSING;
    const path = withTempFamily("${CANGO_T_MISSING}");
    await expect(new YamlFamilySource(path).load()).rejects.toThrow(/CANGO_T_MISSING/);
    rmSync(join(path, ".."), { recursive: true, force: true });
  });

  test("substitutes the env value when it is set", async () => {
    process.env.CANGO_T_PRESENT = "pw-ok";
    const path = withTempFamily("${CANGO_T_PRESENT}");
    const { connections } = await new YamlFamilySource(path).load();
    const dav = connections.find((c) => c.sourceId === "src-dav");
    expect(dav?.kind === "caldav" && dav.password).toBe("pw-ok");
    rmSync(join(path, ".."), { recursive: true, force: true });
  });
});
