import express, {type RequestHandler} from 'express';
import {fileURLToPath} from 'node:url';
import {
  createStore,
  diffAgainstActive,
  evaluateRelease,
  nextId,
  snapshotMember,
  validatePlan,
  type Draft,
  type FrozenPlan,
  type Release,
} from './store';

// Max simulated validation window for the `validationDelayMs` test knob.
const MAX_VALIDATION_DELAY_MS = 2000;

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({limit: '1mb'}));
  const store = createStore();

  const activeRelease = (): Release =>
    store.releases.find((release) => release.id === store.activeReleaseId)!;

  const draftSummary = (draft: Draft) => {
    const {content: _content, ...summary} = draft;
    return summary;
  };

  const publicState = () => ({
    envs: [...store.envs],
    activeReleaseId: store.activeReleaseId,
    drafts: [...store.drafts.values()].map((draft) => structuredClone(draft)),
    releases: store.releases.map((release) => ({
      id: release.id,
      createdAt: release.createdAt,
      note: release.note,
      environment: release.environment,
      kind: release.kind,
      parentId: release.parentId,
      rolledBackFrom: release.rolledBackFrom,
      members: release.members.map((member) => ({id: member.id, revision: member.revision})),
    })),
  });

  app.get('/api/bootstrap', (_req, res) =>
    res.json({family: 'feature-eval', count: store.drafts.size}),
  );

  // Whole workbench state in one round trip.
  app.get('/api/state', (_req, res) => res.json(publicState()));

  app.get('/api/flags', (_req, res) =>
    res.json([...store.drafts.values()].map(draftSummary)),
  );

  app.get('/api/flags/:id', (req, res) => {
    const draft = store.drafts.get(req.params.id);
    if (!draft) return res.status(404).json({error: 'not_found'});
    res.set('ETag', String(draft.revision)).json(structuredClone(draft));
  });

  app.post('/api/flags', (req, res) => {
    const id = String(req.body?.id ?? nextId(store, 'flag'));
    if (store.drafts.has(id)) return res.status(409).json({error: 'flag_exists', flagId: id});
    const draft: Draft = {
      id,
      name: String(req.body?.name ?? id),
      revision: 1,
      content: String(req.body?.content ?? ''),
      state: req.body?.state === 'disabled' ? 'disabled' : 'active',
      envs: asStringList(req.body?.envs) ?? [...store.envs],
      dependsOn: asStringList(req.body?.dependsOn) ?? [],
      updatedAt: new Date().toISOString(),
    };
    store.drafts.set(id, draft);
    res.status(201).json(structuredClone(draft));
  });

  app.put('/api/flags/:id', (req, res) => {
    const draft = store.drafts.get(req.params.id);
    if (!draft) return res.status(404).json({error: 'not_found'});
    if (req.body?.revision !== draft.revision) {
      return res.status(409).json({error: 'revision_conflict', current: structuredClone(draft)});
    }
    if (typeof req.body?.content === 'string') draft.content = req.body.content;
    if (typeof req.body?.name === 'string') draft.name = req.body.name;
    if (req.body?.state === 'active' || req.body?.state === 'disabled') draft.state = req.body.state;
    const envs = asStringList(req.body?.envs);
    if (envs) draft.envs = envs;
    const dependsOn = asStringList(req.body?.dependsOn);
    if (dependsOn) draft.dependsOn = dependsOn;
    draft.revision += 1;
    draft.updatedAt = new Date().toISOString();
    res.json(structuredClone(draft));
  });

  // Removing a draft never rewrites history: old releases stay auditable and
  // any new publish still referencing it fails validation.
  app.delete('/api/flags/:id', (req, res) => {
    if (!store.drafts.delete(req.params.id)) {
      return res.status(404).json({error: 'not_found'});
    }
    res.status(204).send();
  });

  app.post('/api/flags/:id/analyze', async (req, res) => {
    const draft = store.drafts.get(req.params.id);
    if (!draft) return res.status(404).json({error: 'not_found'});
    await new Promise((resolve) =>
      setTimeout(resolve, req.params.id === 'alpha' ? 100 : 20),
    );
    const content = String(req.body?.content ?? draft.content);
    res.json({
      id: draft.id,
      revision: draft.revision,
      lines: content.split(/\r?\n/).length,
      diagnostics: [],
    });
  });

  // --- Publish -------------------------------------------------------------

  const publishHandler: RequestHandler = async (req, res) => {
    const rawFlagIds: unknown[] = Array.isArray(req.body?.flagIds)
      ? req.body.flagIds
      : [];
    const flagIds: string[] = [...new Set(rawFlagIds.map(String))];
    const expectedRevisions = new Map<string, number>(
      Object.entries(req.body?.expectedRevisions ?? {}).map(([id, revision]) => [
        id,
        Number(revision),
      ]),
    );
    const environment = String(req.body?.environment ?? '');
    const note = String(req.body?.note ?? '');
    const delayMs = clampDelayMs(req.body?.validationDelayMs);
    const baseAtRequest = activeRelease(); // pointer captured before any await

    // Phase 1: synchronously freeze the draft revision set.
    // A flag deleted between freeze and commit is not "unknown" at request
    // time — it surfaces as a draft_changed conflict in phase 3 instead.
    const frozen: FrozenPlan = {members: []};
    const unknownAtFreeze: string[] = [];
    for (const id of flagIds) {
      const draft = store.drafts.get(id);
      if (!draft) unknownAtFreeze.push(id);
      else frozen.members.push(structuredClone(draft));
    }
    if (unknownAtFreeze.length > 0) {
      return res.status(422).json({
        error: 'validation_failed',
        issues: unknownAtFreeze.map((flagId) => ({code: 'unknown_flag', flagId})),
      });
    }

    // Phase 2: validation runs against the frozen snapshot only.
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const issues = validatePlan(store, frozen, environment);
    if (issues.length > 0) {
      // Nothing was switched; the failed release is not even recorded.
      return res.status(422).json({error: 'validation_failed', issues});
    }

    // Phase 3: single synchronous critical section — CAS + pointer switch.
    const currentActive = activeRelease();

    // Freeze-vs-current drift: drafts changed (or were deleted) during
    // validation. This is the retryable conflict path (409) and takes
    // precedence: the request was valid when sent, the world moved.
    const draftChanged = frozen.members
      .map((member) => {
        const current = store.drafts.get(member.id);
        if (!current) {
          return {
            kind: 'draft_changed' as const,
            flagId: member.id,
            expectedRevision: member.revision,
            currentRevision: null,
          };
        }
        if (current.revision !== member.revision) {
          return {
            kind: 'draft_changed' as const,
            flagId: member.id,
            expectedRevision: member.revision,
            currentRevision: current.revision,
          };
        }
        return null;
      })
      .filter((value): value is NonNullable<typeof value> => value !== null);

    const movedConflicts = diffAgainstActive(frozen, baseAtRequest, currentActive);
    // Collapse to the minimal set: one entry per flag. A release-race entry
    // already names the active revision, so it subsumes a draft drift entry.
    const movedFlagIds = new Set(movedConflicts.map((conflict) => conflict.flagId));
    const driftConflicts = draftChanged.filter(
      (conflict) => !movedFlagIds.has(conflict.flagId),
    );
    if (driftConflicts.length > 0 || movedConflicts.length > 0) {
      // Loser keeps its draft: server changed nothing; return refresh payload
      // plus the minimal conflict set so the publisher can retry.
      return res.status(409).json({
        error: 'publish_conflict',
        baseReleaseId: baseAtRequest.id,
        currentActiveReleaseId: currentActive.id,
        conflicts: [...movedConflicts, ...driftConflicts],
        state: publicState(),
      });
    }

    // No drift, but the client's declared last-known revisions did not match
    // the frozen snapshot: the request was stale when sent (malformed retry).
    const badExpected = frozen.members.filter(
      (member) => expectedRevisions.has(member.id) && expectedRevisions.get(member.id) !== member.revision,
    );
    if (badExpected.length > 0) {
      return res.status(400).json({
        error: 'stale_request',
        conflicts: badExpected.map((member) => ({
          kind: 'expected_mismatch',
          flagId: member.id,
          expectedRevision: expectedRevisions.get(member.id),
          frozenRevision: member.revision,
        })),
      });
    }

    const release: Release = {
      id: nextId(store, 'rel'),
      createdAt: new Date().toISOString(),
      note,
      environment,
      kind: 'publish',
      parentId: currentActive.id,
      members: frozen.members.map(snapshotMember),
    };
    store.releases.push(release);
    store.activeReleaseId = release.id;
    return res.status(201).json({release: publicRelease(release), state: publicState()});
  };

  app.post('/api/releases/publish', publishHandler);

  // Rollback appends a NEW release that copies a historical snapshot. The
  // historical release is never moved or rewritten, so audit trails survive.
  // The handler is fully synchronous, so concurrent rollback/publish requests
  // are serialized by the event loop and each switch is itself atomic.
  app.post('/api/releases/:id/rollback', (req, res) => {
    const source = store.releases.find((release) => release.id === req.params.id);
    if (!source) return res.status(404).json({error: 'not_found'});
    const currentActive = activeRelease();

    const release: Release = {
      id: nextId(store, 'rel'),
      createdAt: new Date().toISOString(),
      note: String(req.body?.note ?? `rollback to ${source.id}`),
      environment: source.environment,
      kind: 'rollback',
      parentId: currentActive.id,
      rolledBackFrom: source.id,
      members: source.members.map((member) => structuredClone(member)),
    };
    store.releases.push(release);
    store.activeReleaseId = release.id;
    res.status(201).json({release: publicRelease(release), state: publicState()});
  });

  app.get('/api/releases', (_req, res) =>
    res.json(store.releases.map(publicRelease)),
  );

  app.get('/api/releases/:id', (req, res) => {
    const release = store.releases.find((value) => value.id === req.params.id);
    if (!release) return res.status(404).json({error: 'not_found'});
    res.json(publicRelease(release));
  });

  // Evaluation: capture one release synchronously, then compute from that
  // snapshot alone. A request can therefore see the complete old release or
  // the complete new release — never a mix.
  app.post('/api/evaluate', (req, res) => {
    const release = activeRelease();
    const environment = String(req.body?.environment ?? release.environment);
    const evaluated = evaluateRelease(release, environment);
    res.json({
      releaseId: release.id,
      environment,
      flags: [...evaluated.values()].map(({on, id, revision, name, state}) => ({
        id,
        name,
        revision,
        state,
        on,
      })),
    });
  });

  return app;
}

function publicRelease(release: Release) {
  return structuredClone(release);
}

function asStringList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return undefined;
  return (value as unknown[]).map((entry) => String(entry));
}

function clampDelayMs(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(parsed, MAX_VALIDATION_DELAY_MS);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () =>
    console.log('server http://127.0.0.1:4174'),
  );
}
