import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { ZodType, ZodTypeDef } from "zod";
import {
  buildFamily,
  checkReferences,
  expandConnectionEnv,
  familyFileSchema,
  rulesFileSchema,
  type FamilyFile,
  type RulesFile,
  type ValidationIssue,
} from "./config.ts";
import { fetchSource, refreshWindow } from "./sources.ts";

/**
 * cango-validate — check family.yaml / rules.yaml before deploying them.
 *
 *   bun run src/validate.ts <family.yaml> [rules.yaml] [--live]
 *
 * Static by default: runs the same Zod schemas the daemon uses plus semantic
 * cross-reference checks (dangling sourceIds, unknown ownerId/personId,
 * duplicate ids, bad title regexes). Exit 0 if clean, 1 if any issue.
 *
 * With --live it also connects to every source to confirm URLs and
 * credentials actually work. ${VAR} placeholders in source fields are expanded
 * from the environment first (the same secrets the daemon would be given via
 * /etc/cango.env), so export them before running, e.g.
 *
 *   CANGO_WORK_PASSWORD=… bun run src/validate.ts family.yaml --live
 */

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

interface Parsed<T> {
  /** The schema-valid document, or undefined if parsing/validation failed. */
  doc?: T;
  issues: ValidationIssue[];
}

function readArgs(argv: string[]): {
  familyPath: string | undefined;
  rulesPath: string | undefined;
  live: boolean;
} {
  const positional: string[] = [];
  let live = false;
  for (const arg of argv) {
    if (arg === "--live") live = true;
    else positional.push(arg);
  }
  return { familyPath: positional[0], rulesPath: positional[1], live };
}

async function parseFile<T>(
  path: string,
  file: "family" | "rules",
  schema: ZodType<T, ZodTypeDef, unknown>,
): Promise<Parsed<T>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    return { issues: [{ file, path: path, message: `cannot read file: ${errMsg(err)}` }] };
  }

  let raw: unknown;
  try {
    raw = parseYaml(text) ?? {};
  } catch (err) {
    return { issues: [{ file, path: "(yaml)", message: `YAML parse error: ${errMsg(err)}` }] };
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((iss) => ({
      file,
      path: iss.path.length ? iss.path.join(".") : "(root)",
      message: iss.message,
    }));
    return { issues };
  }
  return { doc: result.data, issues: [] };
}

interface LiveResult {
  sourceId: string;
  kind: string;
  ok: boolean;
  detail: string;
}

async function runLive(family: FamilyFile): Promise<LiveResult[]> {
  const { connections } = buildFamily(family);
  const window = refreshWindow();
  const results: LiveResult[] = [];

  for (const conn of connections) {
    const { connection: expanded, missing } = expandConnectionEnv(conn);
    if (missing.length > 0) {
      results.push({
        sourceId: conn.sourceId,
        kind: conn.kind,
        ok: false,
        detail: `env var(s) not set: ${[...new Set(missing)].join(", ")}`,
      });
      continue;
    }
    try {
      const events = await fetchSource(expanded, window, () => "live-check");
      results.push({
        sourceId: conn.sourceId,
        kind: conn.kind,
        ok: true,
        detail: `${events.length} event(s) in look window`,
      });
    } catch (err) {
      results.push({ sourceId: conn.sourceId, kind: conn.kind, ok: false, detail: errMsg(err) });
    }
  }
  return results;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function reportFile(label: string, present: boolean, issues: ValidationIssue[]): void {
  if (!present) {
    console.log(`${DIM}- ${label} (not provided, skipped)${RESET}`);
    return;
  }
  if (issues.length === 0) {
    console.log(`${GREEN}✓ ${label} valid${RESET}`);
    return;
  }
  console.log(`${RED}✗ ${label}${RESET}`);
  for (const iss of issues) {
    console.log(`  ${iss.path} ${DIM}—${RESET} ${iss.message}`);
  }
}

async function run(): Promise<void> {
  const { familyPath, rulesPath, live } = readArgs(process.argv.slice(2));
  if (!familyPath) {
    console.error("usage: cango-validate <family.yaml> [rules.yaml] [--live]");
    process.exit(2);
  }

  const family = await parseFile<FamilyFile>(familyPath, "family", familyFileSchema);
  const rules: Parsed<RulesFile> = rulesPath
    ? await parseFile<RulesFile>(rulesPath, "rules", rulesFileSchema)
    : { issues: [] };

  // Cross-reference checks only run once both files passed their schema.
  const refIssues =
    family.doc && (rulesPath ? rules.doc : true)
      ? checkReferences(family.doc, rules.doc ?? { rules: [] })
      : [];

  const familyIssues = [...family.issues, ...refIssues.filter((i) => i.file === "family")];
  const rulesIssues = [...rules.issues, ...refIssues.filter((i) => i.file === "rules")];

  reportFile("family.yaml", true, familyIssues);
  reportFile("rules.yaml", rulesPath !== undefined, rulesIssues);

  const staticOk = familyIssues.length === 0 && rulesIssues.length === 0;

  let liveOk = true;
  if (live) {
    console.log(`\n${DIM}live connection check…${RESET}`);
    if (!family.doc) {
      console.log(`${YELLOW}! skipped: family.yaml must be valid first${RESET}`);
      liveOk = false;
    } else {
      const results = await runLive(family.doc);
      if (results.length === 0) console.log(`${DIM}  (no sources)${RESET}`);
      for (const r of results) {
        const tag = r.ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
        console.log(`  ${tag} ${r.sourceId} ${DIM}(${r.kind})${RESET} — ${r.detail}`);
        if (!r.ok) liveOk = false;
      }
    }
  }

  if (staticOk && liveOk) {
    console.log(`\n${GREEN}all checks passed${RESET}`);
    process.exit(0);
  }
  console.log(`\n${RED}validation failed${RESET}`);
  process.exit(1);
}

void run();
