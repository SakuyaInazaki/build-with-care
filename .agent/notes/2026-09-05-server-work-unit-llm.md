# Server / Work Unit / LLM Changes

## Changes

- Added HTTP work-unit execution and query routes: `POST`/`GET /api/sessions/:id/units` and `POST`/`GET /api/sessions/:id/constraints`.
- Specs now accept text constraints, structured constraints, or both. Text constraints are derived deterministically when needed.
- Human constraints and adjudication constraints are recorded as structured, forward-only constraints with `affectsFromTurn`; earlier cards are not rewritten.
- New sessions inject configured LLM judge and recorder instances. Configuration reporting is generated from the same resolved configuration.
- Deterministic red results are a hard policy floor: an LLM judge may add risk or explanation but cannot downgrade a rule conflict.
- Verification requires an explicit boolean and remains human evidence unless produced by the executor. Ended sessions reject all write operations.
- SSE writes now use a bounded queue, drain handling, overflow cleanup, and listener cleanup for disconnected clients.
- Demo full flow now uses semantic work units, including the cache unit, SQLite red gate, Postgres correction, tool execution, executor evidence, and runtime failure demonstration.
- LLM runner now exposes `begin_unit` / `end_unit` and routes subsequent tools through `executeInUnit`.

## Reasons and impact

The work-unit contract makes approval happen at semantic boundaries while retaining per-tool safety checks and executor evidence. Structured constraints make forward-only correction explicit and prevent historical recoloring. LLM provenance now reflects the actual instances used by a session instead of only describing configuration.

## Limitations

- Persistence restore reconstructs the append-only state, but external workspace side effects remain intentionally non-reversible in rewind-and-fork mode.
- The scripted demo's multi-agent scenario still uses the existing concurrent narrative and is not a complete physical multi-agent scheduler.
- SSE clients that exceed the bounded queue are closed rather than allowed to consume unbounded memory.

## Verification

- `npm run typecheck`
- `npm test -- --reporter=dot`
- `npm run build`
