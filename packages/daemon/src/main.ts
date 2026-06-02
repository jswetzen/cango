import { join } from "node:path";
import { Cache } from "./cache.ts";
import { loadConfig, type LoadedConfig } from "./config.ts";
import { Refresher } from "./cron.ts";
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
  const rulesPath = env("CANGO_RULES_PATH", join(dataDir, "rules.yaml"));
  const dbPath = env("CANGO_DB_PATH", join(dataDir, "events.db"));
  const socketPath = env("CANGO_SOCKET_PATH", "/run/cango/cango.sock");

  log(`loading config from ${familyPath} + ${rulesPath}`);
  let config: LoadedConfig = await loadConfig(familyPath, rulesPath);

  const cache = new Cache(dbPath);
  const refresher = new Refresher(cache, config, { log });

  const ctx: RpcContext = {
    cache,
    getConfig: () => config,
    refresher,
    reload: async () => {
      log("reloading config");
      config = await loadConfig(familyPath, rulesPath);
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
