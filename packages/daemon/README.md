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
| `CANGO_DB_PATH` | `$CANGO_DATA_DIR/events.db` | SQLite event cache |
| `CANGO_STATE_PATH` | `/state/cango/state.db` | Durable rule store (see below) |
| `CANGO_SOCKET_PATH` | `/run/cango/cango.sock` | JSON-RPC socket |

See `examples/family.yaml.example`.

### Storage: three tiers, three lifecycles

Cango deliberately keeps three kinds of state apart so deployment needs **no
special cases** (no "remember not to overwrite this file" rules):

| Path | Holds | Lifecycle |
|---|---|---|
| config (templated) | `family.yaml` (+ secrets) | rewritten each deploy |
| `$CANGO_DATA_DIR` | `events.db` | **disposable cache** — safe to wipe; rebuilt from feeds |
| `$CANGO_STATE_PATH` | `state.db` | **durable** — rules created/amended at runtime; must persist |

`state.db` is the only tier that must be backed up. Put it on its **own
dedicated persistent disk** (like knowitall's data disk), separate from both the
templated config and the disposable cache — then the generic disk handling
persists it across deploys with no app-specific logic. Backup = snapshot that
disk (or copy `state.db`). Rules are inspected with `listRules`.

Rules are no longer a file. On first run the daemon seeds the (now deprecated)
`family.yaml` `attendance:` edges into `state.db` once; thereafter rules are
managed at runtime via `createRule` / `amendRule` / `retractRule`.

## Smoke-test client

`cango-cli` opens the socket, sends one request, prints the response:

```sh
CANGO_SOCKET_PATH=/run/cango/cango.sock bun run src/cli.ts health
bun run src/cli.ts checkAvailability '{"start":"2026-06-01T09:00:00Z","end":"2026-06-01T17:00:00Z","people":["p-me"]}'
```

## Protocol

Length-prefixed (4-byte big-endian uint32) JSON-RPC 2.0 frames. Methods:
`checkAvailability`, `findFreeSlot`, `listEvents`, `explainEvent`, `listSeries`,
`createEvent`, `listRules`, `createRule`, `amendRule`, `retractRule`,
`reloadConfig`, `health`. Every result carries `degraded: boolean` and
`stale_sources: string[]`.

## Tests

```sh
bun test
```

Covers the SQLite cache, the durable rule store (CRUD + soft-delete + seeding),
the refresher (with stubbed adapters + backoff), and a full socket round-trip
including live rule mutation and out-of-office masking.
