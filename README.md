# Feature Evaluation Lab

Local workbench for evaluation rules with atomic multi-flag releases.

Run `npm install`, then `npm run dev` (API on :4174, UI on :4173).
Tests: `npm test`. Type-check + build: `npm run build`.

## Model

- **Draft** (`/api/flags`): mutable workbench copy, guarded by a numeric
  `revision` (optimistic concurrency, `If-Match`-style 409 on stale writes).
- **Release** (`/api/releases`): append-only, deep-frozen snapshot of every
  flag. Each release has `parentId` (previous tip) and, for rollbacks,
  `rollbackOf` (the release whose content it restores).
- **Pointer**: a single server-side `currentReleaseId`; evaluation reads only
  through the pointer.

## Publishing

`POST /api/releases/publish` with `{flags: [{id, revision?}], note}` (empty
flags means "all drafts") runs two phases:

1. **Freeze** — the requested flag ids + revisions are snapshotted and the
   base release is recorded.
2. **Validate & commit** — after awaiting validation, the handler
   synchronously re-checks drafts and the release pointer, validates the full
   effective flag set (dependency closure, cycles, environment constraints,
   rule syntax) and only then appends one release and flips the pointer.
   Because the commit section has no `await`, readers can only observe the
   complete old release or the complete new one.

Failure modes:

- `422 validation_failed` — all violations returned; nothing is applied
  (all-or-nothing, including when only part of the batch is invalid).
- `409 stale_revision` — an explicit client revision no longer matches at
  freeze time.
- `409 publish_conflict` — a draft changed during validation, or a competing
  release overwrote one of the same flags. The body contains the **minimal
  conflict set** (one entry per affected flag); the losing drafts are never
  modified. Racing publishes over disjoint flag sets auto-rebase.

## Rollback

`POST /api/releases/:id/rollback` creates a **new** release containing the
target release's full content (`parentId` = current tip, `rollbackOf` =
target). Historical releases are never moved or mutated and remain auditable
via `GET /api/releases` and `GET /api/releases/:id?full=1`.

## Reading

`GET /api/evaluate?env=prod&flag=alpha` resolves the pointer exactly once per
request; every response carries its `releaseId` and is internally consistent
with that snapshot.
