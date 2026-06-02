import { rpcCall } from "./client.ts";

/**
 * cango-cli — tiny smoke-test client for the daemon socket.
 *
 *   bun run src/cli.ts <method> [jsonParams]
 *   bun run src/cli.ts health
 *   bun run src/cli.ts checkAvailability '{"start":"2026-06-01T09:00:00Z","end":"2026-06-01T17:00:00Z"}'
 *
 * Socket path: $CANGO_SOCKET_PATH (default /run/cango/cango.sock).
 */
async function run(): Promise<void> {
  const [method, rawParams] = process.argv.slice(2);
  if (!method) {
    console.error(
      "usage: cango-cli <method> [jsonParams]\n" +
        "methods: checkAvailability, findFreeSlot, listEvents, explainEvent, " +
        "listSeries, reloadConfig, health",
    );
    process.exit(2);
  }
  const socketPath = process.env.CANGO_SOCKET_PATH ?? "/run/cango/cango.sock";

  let params: unknown;
  if (rawParams) {
    try {
      params = JSON.parse(rawParams);
    } catch (err) {
      console.error(`invalid JSON params: ${String(err)}`);
      process.exit(2);
    }
  }

  try {
    const result = await rpcCall(socketPath, method, params);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void run();
