import type { Cache } from "./cache.ts";
import type { LoadedConfig } from "./config.ts";

/**
 * Everything that must happen whenever config is (re)loaded, in one place so
 * the startup and hot-reload paths can't drift apart.
 *
 * Both steps exist because config changes used to fail *quietly*: a source
 * removed from family.yaml left its events cached forever (and resolving as
 * `hard`), and a dangling reference — an unknown `defaultOccupants` group id,
 * say — loaded without a word and silently occupied nobody.
 */
export function reconcileConfig(
  cache: Cache,
  config: LoadedConfig,
  log: (msg: string) => void,
): void {
  for (const issue of config.issues) {
    log(`config warning: ${issue.path} — ${issue.message}`);
  }

  const pruned = cache.pruneUnknownSources(config.connections.map((c) => c.sourceId));
  for (const p of pruned) {
    log(`pruned ${p.events} event(s) from unknown source "${p.sourceId}"`);
  }
}
