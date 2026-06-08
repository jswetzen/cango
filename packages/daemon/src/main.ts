import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Cache } from "./cache.ts";
import { loadConfig, type LoadedConfig } from "./config.ts";
import { Refresher } from "./cron.ts";
import { RuleStore } from "./ruleStore.ts";
import { startServer } from "./server.ts";
import type { RpcContext } from "./rpc.ts";

function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function log(msg: string): void {
  console.log(`[cango] ${new Date().toISOString()} ${msg}`);
}

export async function main(): Promise<void> {
  const dataDir = env("CANGO_DATA_DIR", "/data/cango");
  const familyPath = env("CANGO_FAMILY_PATH", join(dataDir, "family.yaml"));
  const dbPath = env("CANGO_DB_PATH", join(dataDir, "events.db"));
  // Durable rule state lives on a *dedicated* persistent disk, deliberately off
  // the (disposable/templated) data dir so deploys never overwrite it.
  const statePath = env("CANGO_STATE_PATH", "/state/cango/state.db");
  const socketPath = env("CANGO_SOCKET_PATH", "/run/cango/cango.sock");

  log(`loading config from ${familyPath}`);
  let config: LoadedConfig = await loadConfig(familyPath);

  const cache = new Cache(dbPath);
  mkdirSync(dirname(statePath), { recursive: true });
  const ruleStore = new RuleStore(statePath);
  const seeded = ruleStore.seedFromAttendance(config.attendanceSeed);
  if (seeded > 0) log(`seeded ${seeded} rule(s) from family.yaml attendance`);

  const refresher = new Refresher(cache, config, { log });

  const ctx: RpcContext = {
    cache,
    getConfig: () => config,
    rules: ruleStore,
    refresher,
    reload: async () => {
      log("reloading config");
      config = await loadConfig(familyPath);
      refresher.setConfig(config);
      cache.clearResolvedCache();
    },
  };

  const server = startServer(socketPath, ctx, log);

  // Initial refresh + recurring schedule (don't block socket availability).
  void refresher.start().catch((err) => log(`initial refresh error: ${String(err)}`));

  const shutdown = () => {
    log("shutting down");
    refresher.stop();
    server.stop();
    cache.close();
    ruleStore.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log("ready");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[cango] fatal: ${String(err)}`);
    process.exit(1);
  });
}
