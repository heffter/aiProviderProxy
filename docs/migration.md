# Migrating from RelayPlane to aiproviderproxy

`aipp migrate-from-relayplane` imports an existing RelayPlane install into the
new `aiproviderproxy` (`aipp`) layout. It is safe and reversible.

## What it does

1. Reads `~/.relayplane/config.json` (legacy schema v4) and maps it to config
   schema v1 at `~/.aiproviderproxy/config.json`:
   - `providers` (and `ollama`) -> `providers`
   - `modelOverrides` -> `models.overrides`
   - `routing.mode` / `mode` -> `routing.mode`
   - `crossProviderCascade` -> `routing.crossProviderCascade`
   - `budget`, `cache`, `alerts`, `anomaly` -> the matching v1 sections
   - `dashboard.showRequestContent` -> `contentLog.enabled`
     (on unless explicitly `false`, matching legacy behaviour)
   - `rateLimit`, `traces` -> preserved as-is with a warning (not yet modelled in v1)
2. Copies the legacy data files into `~/.aiproviderproxy/`:
   `history.jsonl`, `routing-log.jsonl`, `agents.json`, `sessions.db`,
   `budget.db`, `alerts.db`, `osmosis.db`, `mesh.db`, and the `traces/` and
   `cache/` directories.
3. Writes a marker file `~/.aiproviderproxy/.migrated-from-relayplane.json`.

RelayPlane cloud telemetry and `api_key` are intentionally **not** migrated
(the cloud integration is removed, decision D-001).

## Idempotency

Re-running is a no-op once the marker file exists. Use `--force` to run again
(the previous `config.json` is backed up to `config.json.bak` first).

## Rollback

The migration **never modifies `~/.relayplane`**. To roll back, simply keep
using the old RelayPlane install (or point tooling back at `~/.relayplane`).
Nothing needs to be undone; you may delete `~/.aiproviderproxy` if you want a
clean slate.

## Safety

- The source tree is read-only during migration.
- The target `config.json` is written atomically with a `.bak` backup
  (FR-CONFIG-002, FR-CONFIG-008).
- Secrets are never embedded in the migrated config; providers reference
  credentials by env var or file (FR-CONFIG-004).
