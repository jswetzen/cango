# @cango/daemon

The Cango sidecar. A long-lived Bun process that refreshes calendar feeds into
a local SQLite cache and answers scheduling questions over a Unix-socket
JSON-RPC interface. No MCP, no HTTP — knowitall fronts it (see `PLAN.md`).

## Run

```sh
bun run src/main.ts
```

Configuration is via environment variables (defaults match the deployed
layout):

| Env | Default | Purpose |
|---|---|---|
| `CANGO_DATA_DIR` | `/data/cango` | Base dir for the defaults below |
| `CANGO_FAMILY_PATH` | `$CANGO_DATA_DIR/family.yaml` | FamilyGraph + source defs |
| `CANGO_RULES_PATH` | `$CANGO_DATA_DIR/rules.yaml` | Role-resolution rules |
| `CANGO_DB_PATH` | `$CANGO_DATA_DIR/events.db` | SQLite event cache |
| `CANGO_SOCKET_PATH` | `/run/cango/cango.sock` | JSON-RPC socket |

See `examples/family.yaml.example` and `examples/rules.yaml.example`.

## Smoke-test client

`cango-cli` opens the socket, sends one request, prints the response:

```sh
CANGO_SOCKET_PATH=/run/cango/cango.sock bun run src/cli.ts health
bun run src/cli.ts checkAvailability '{"start":"2026-06-01T09:00:00Z","end":"2026-06-01T17:00:00Z","people":["p-me"]}'
```

## Protocol

Length-prefixed (4-byte big-endian uint32) JSON-RPC 2.0 frames. Methods:
`checkAvailability`, `findFreeSlot`, `listEvents`, `explainEvent`, `listSeries`,
`reloadConfig`, `health`. Every result carries `degraded: boolean` and
`stale_sources: string[]`.

## Tests

```sh
bun test
```

Covers the SQLite cache, the refresher (with stubbed adapters + backoff), and a
full socket round-trip for all seven methods including hot reload.
