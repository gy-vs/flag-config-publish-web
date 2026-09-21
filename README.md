# Feature Rules Workbench

Local workbench for publishing interdependent feature-flag drafts as one
atomic, all-or-nothing release, with auditable rollback.

Run `npm install`, then `npm run dev` (server on :4174, UI on :4173).
Tests: `npm test` · Type-check + build: `npm run build`.

## Model

- **Drafts** (`src/server/store.ts`) are mutable flag configs; every edit bumps
  an optimistic-lock `revision`.
- **Releases** are immutable snapshots with a fixed set of members
  (`id@revision` plus full content, state, env constraints and dependency
  edges). Release history is append-only.
- Exactly one release is **active**. Publishing and rollback only move that
  single pointer; they never mutate drafts and never move or rewrite history.

## Publish protocol (freeze → validate → atomic switch)

`POST /api/releases/publish` with `{flagIds, environment, note, expectedRevisions?}`:

1. **Freeze** — deep copies of every selected draft revision are taken
   synchronously before the first `await`. Validation observes only this set.
2. **Validate** — dependency closure must be fully contained in the selection,
   referenced flags must exist, every selected flag must allow the target
   environment, and the closure graph must be acyclic (Tarjan SCC). *All*
   problems are collected; any failure aborts with 422 and nothing switches
   (the failed release is not even recorded).
3. **Atomic commit** — after validation, a single synchronous critical
   section re-checks:
   - each frozen revision still equals the live draft (else
     `draft_changed`, including `currentRevision: null` for a deletion);
   - the footprint against the release captured at request start vs. the now
     active release (`revised` / `would_be_removed` / `reintroduced`).

   Any mismatch returns **409 with the minimal conflict set** and a refreshed
   state payload; the losing page keeps its drafts untouched and can retry.
   `expectedRevisions` that don't even match the frozen snapshot return 400
   (stale request). On success a new release is appended and the pointer is
   switched in the same tick.

`validationDelayMs` (capped, test-only) stretches the validation window so
mid-validation drift and concurrent publishes are deterministic to test.

## Rollback

`POST /api/releases/:id/rollback` appends a **new** release whose members copy
the historical snapshot (`kind: "rollback"`, `rolledBackFrom` points at the
source). The historical release is never moved; drafts stay editable, so after
a rollback you edit and publish again normally.

## Readers never see a torn release

`POST /api/evaluate` captures the active release object synchronously, then
computes `on/off` purely from that snapshot (flag is on when its state is
`active`, the env is allowed, and every dependency in the snapshot is on).
Any request therefore observes the complete old release or the complete new
one — never a mix.

## API summary

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/state` | drafts + release history + active pointer |
| GET/POST/PUT/DELETE | `/api/flags[/:id]` | draft CRUD with revision-based optimistic locking |
| POST | `/api/flags/:id/analyze` | content diagnostics (legacy) |
| POST | `/api/releases/publish` | freeze → validate → atomic switch |
| POST | `/api/releases/:id/rollback` | append a rollback release |
| GET | `/api/releases[/:id]` | immutable release history / detail |
| POST | `/api/evaluate` | consistent evaluation of the active snapshot |

Deleting a draft removes only the editable draft; it stays byte-for-byte in
every release that shipped it, and new publishes still referencing it fail
closure validation.

## Guarantees covered by tests (`test/api.test.ts`)

circular dependencies (2-cycle and self-loop) · drafts changing or being
deleted during validation · partial invalid (all issues reported, zero switch)
· concurrent publishes (loser keeps drafts, minimal conflict set, retry wins) ·
rollback history immutability · edit-after-rollback republish · dependency
edge deletion · deleted-flag references blocked while history stays readable ·
reader switch instant (only the two complete release vectors ever observed).
