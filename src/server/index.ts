import express from 'express';
import {fileURLToPath} from 'node:url';

/**
 * Draft = workbench working copy (mutable, revision-guarded).
 * Release = immutable snapshot of every flag; history is append-only.
 * currentReleaseId is the single pointer evaluation reads through.
 */
export type FlagDraft = {
  id: string;
  name: string;
  revision: number;
  content: string;
  dependencies: string[];
  environments: string[];
  updatedAt: string;
};

export type ReleaseFlag = Pick<FlagDraft, 'id' | 'name' | 'revision' | 'content' | 'dependencies' | 'environments'>;

export type Release = {
  id: string;
  sequence: number;
  flags: Record<string, ReleaseFlag>;
  createdAt: string;
  createdBy: string;
  note: string;
  parentId: string | null;
  rollbackOf: string | null;
};

export type Violation = {code: string; flagId?: string; dependency?: string; environment?: string; path?: string[]; line?: number; message: string};

export type CreateAppOptions = {
  /**
   * Invoked after the revision set has been frozen but before the commit
   * section. Production simply yields; tests use it to mutate drafts or
   * publish a competing release in the middle of validation.
   */
  afterFreeze?: (context: {tentativeReleaseId: string; baseReleaseId: string; flags: ReleaseFlag[]}) => Promise<void> | void;
};

// ---------- pure helpers (also exported for tests) ----------

export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function parseRules(content: string): {pairs: [string, string][]; badLines: number[]} {
  const pairs: [string, string][] = [];
  const badLines: number[] = [];
  content.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const match = /^([A-Za-z0-9_.-]+)\s*[:=]\s*(.+)$/.exec(line);
    if (!match) {
      badLines.push(index + 1);
      return;
    }
    pairs.push([match[1], match[2].trim()]);
  });
  return {pairs, badLines};
}

function findCycles(flags: ReleaseFlag[]): string[][] {
  const byId = new Map(flags.map(flag => [flag.id, flag]));
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const visit = (id: string): void => {
    color.set(id, 1);
    stack.push(id);
    for (const dep of byId.get(id)?.dependencies ?? []) {
      if (!byId.has(dep) || color.get(dep) === 2) continue;
      if (color.get(dep) === 1) {
        const start = stack.indexOf(dep);
        cycles.push([...stack.slice(start), dep]);
        continue;
      }
      visit(dep);
    }
    stack.pop();
    color.set(id, 2);
  };

  for (const flag of flags) if (!color.has(flag.id)) visit(flag.id);
  return cycles;
}

/** Validate a complete, self-contained flag set (the closure). */
export function validateFlagSet(flags: ReleaseFlag[]): Violation[] {
  const violations: Violation[] = [];
  const byId = new Map(flags.map(flag => [flag.id, flag]));
  const seen = new Set<string>();

  const add = (violation: Violation): void => {
    const key = JSON.stringify(violation);
    if (!seen.has(key)) {
      seen.add(key);
      violations.push(violation);
    }
  };

  for (const flag of flags) {
    // rule content
    const {pairs, badLines} = parseRules(flag.content);
    if (pairs.length === 0) {
      add({code: 'empty_rules', flagId: flag.id, message: `flag ${flag.id} has no rules`});
    }
    for (const line of badLines) {
      add({code: 'malformed_rule', flagId: flag.id, line, message: `flag ${flag.id} line ${line} is not "key: value"`});
    }
    const duplicateKeys = new Set<string>();
    const keys = new Set<string>();
    for (const [key] of pairs) {
      if (keys.has(key)) duplicateKeys.add(key);
      keys.add(key);
    }
    for (const key of duplicateKeys) {
      add({code: 'duplicate_rule_key', flagId: flag.id, message: `flag ${flag.id} has duplicate rule key "${key}"`});
    }

    // environment constraints
    if (flag.environments.length === 0) {
      add({code: 'no_environments', flagId: flag.id, message: `flag ${flag.id} targets no environments`});
    }

    // dependency closure
    for (const dep of flag.dependencies) {
      if (!byId.has(dep)) {
        add({code: 'missing_dependency', flagId: flag.id, dependency: dep, message: `flag ${flag.id} depends on unknown flag ${dep}`});
        continue;
      }
      // a dependency must be active in every environment the flag targets
      for (const env of flag.environments) {
        if (!byId.get(dep)!.environments.includes(env)) {
          add({code: 'environment_unsatisfied', flagId: flag.id, dependency: dep, environment: env,
            message: `dependency ${dep} is not active in environment ${env} required by ${flag.id}`});
        }
      }
    }
  }

  // cyclic dependencies (one violation per flag on a cycle)
  for (const cycle of findCycles(flags)) {
    add({code: 'cyclic_dependency', path: cycle, message: `cyclic dependency: ${cycle.join(' -> ')}`});
    for (const id of cycle.slice(0, -1)) {
      add({code: 'cyclic_dependency', flagId: id, path: cycle, message: `flag ${id} is part of a cycle: ${cycle.join(' -> ')}`});
    }
  }

  return violations;
}

function toReleaseFlag(draft: FlagDraft): ReleaseFlag {
  return {
    id: draft.id,
    name: draft.name,
    revision: draft.revision,
    content: draft.content,
    dependencies: [...draft.dependencies],
    environments: [...draft.environments],
  };
}

// ---------- application ----------

export function createApp(options: CreateAppOptions = {}) {
  const afterFreeze = options.afterFreeze ?? (() => Promise.resolve());

  const seedDrafts = (): FlagDraft[] => [
    {id: 'alpha', name: 'Primary evaluation rules', revision: 3,
      content: 'rule.a: on\nrule.b: 42',
      dependencies: ['beta'], environments: ['dev', 'prod'],
      updatedAt: new Date(0).toISOString()},
    {id: 'beta', name: 'Secondary evaluation rules', revision: 5,
      content: 'rule.c: beta',
      dependencies: [], environments: ['dev', 'prod'],
      updatedAt: new Date(1000).toISOString()},
  ];

  const drafts = seedDrafts();

  const initial: Release = {
    id: 'rel-0001',
    sequence: 1,
    flags: Object.fromEntries(drafts.map(draft => [draft.id, toReleaseFlag(draft)])),
    createdAt: new Date(0).toISOString(),
    createdBy: 'system',
    note: 'initial release',
    parentId: null,
    rollbackOf: null,
  };

  const releases: Release[] = [Object.freeze({...initial, flags: Object.fromEntries(Object.entries(initial.flags).map(([id, flag]) => [id, Object.freeze({...flag, dependencies: [...flag.dependencies], environments: [...flag.environments]})]))})];
  let currentReleaseId = initial.id;
  let nextSequence = 2;

  const getDraft = (id: string): FlagDraft | undefined => drafts.find(draft => draft.id === id);
  const getRelease = (id: string): Release | undefined => releases.find(release => release.id === id);
  const currentRelease = (): Release => getRelease(currentReleaseId)!;

  const buildRelease = (base: Release, override: ReleaseFlag[], fields: {note: string; createdBy: string; rollbackOf: string | null; parentId: string}): Release => {
    const flags = Object.fromEntries(Object.entries(base.flags));
    for (const flag of override) flags[flag.id] = {...flag, dependencies: [...flag.dependencies], environments: [...flag.environments]};
    const release: Release = {
      id: `rel-${String(nextSequence).padStart(4, '0')}`,
      sequence: nextSequence,
      flags,
      createdAt: new Date().toISOString(),
      createdBy: fields.createdBy,
      note: fields.note,
      parentId: fields.parentId,
      rollbackOf: fields.rollbackOf,
    };
    nextSequence += 1;
    Object.values(release.flags).forEach(flag => Object.freeze(flag));
    Object.freeze(release.flags);
    Object.freeze(release);
    releases.push(release);
    currentReleaseId = release.id;
    return release;
  };

  const summarize = (release: Release) => ({
    id: release.id,
    sequence: release.sequence,
    createdAt: release.createdAt,
    createdBy: release.createdBy,
    note: release.note,
    parentId: release.parentId,
    rollbackOf: release.rollbackOf,
    flags: Object.fromEntries(Object.values(release.flags).map(flag => [flag.id, {revision: flag.revision, name: flag.name}])),
  });

  const app = express();
  app.use(express.json({limit: '1mb'}));

  // ---------- workbench draft API ----------

  app.get('/api/bootstrap', (_req, res) =>
    res.json({family: 'feature-eval', count: drafts.length, currentReleaseId}));

  app.get('/api/flags', (_req, res) =>
    res.json(drafts.map(({content, ...row}) => row)));

  app.get('/api/flags/:id', (req, res) => {
    const draft = getDraft(req.params.id);
    if (!draft) return res.status(404).json({error: 'not_found'});
    res.set('ETag', String(draft.revision)).json(draft);
  });

  // Save a draft. Never moves the release pointer; revisions guard lost updates.
  app.put('/api/flags/:id', (req, res) => {
    const draft = getDraft(req.params.id);
    if (!draft) return res.status(404).json({error: 'not_found'});
    if (req.body.revision !== draft.revision) {
      return res.status(409).json({error: 'revision_conflict', current: draft, currentReleaseId});
    }
    if (typeof req.body.content === 'string') draft.content = req.body.content;
    if (typeof req.body.name === 'string') draft.name = req.body.name;
    if (Array.isArray(req.body.dependencies)) draft.dependencies = [...new Set((req.body.dependencies as unknown[]).map(String))];
    if (Array.isArray(req.body.environments)) draft.environments = [...new Set((req.body.environments as unknown[]).map(String))];
    draft.revision += 1;
    draft.updatedAt = new Date().toISOString();
    res.json(draft);
  });

  app.post('/api/flags/:id/analyze', async (req, res) => {
    const draft = getDraft(req.params.id);
    if (!draft) return res.status(404).json({error: 'not_found'});
    const content = String(req.body.content ?? draft.content);
    const violations = validateFlagSet([
      {...toReleaseFlag(draft), content, dependencies: Array.isArray(req.body.dependencies) ? req.body.dependencies : draft.dependencies},
    ]).filter(violation => violation.code !== 'missing_dependency');
    await new Promise(resolve => setTimeout(resolve, 20));
    res.json({id: draft.id, revision: draft.revision, lines: content.split(/\r?\n/).length, violations});
  });

  // ---------- release publish (two-phase: freeze -> validate -> atomic commit) ----------

  app.post('/api/releases/publish', async (req, res) => {
    const requested: Array<{id: string; revision?: number}> =
      Array.isArray(req.body?.flags) && req.body.flags.length > 0
        ? req.body.flags.map((entry: unknown) =>
            typeof entry === 'string' ? {id: entry} : {id: String((entry as {id: string}).id), revision: (entry as {revision?: number}).revision})
        : drafts.map(draft => ({id: draft.id}));

    // Phase 1a: resolve + freeze the requested revision set synchronously.
    const ids: string[] = [];
    for (const entry of requested) if (!ids.includes(entry.id)) ids.push(entry.id);
    const requestedRevisions = new Map<string, number | undefined>();
    for (const item of requested) requestedRevisions.set(item.id, item.revision);

    const frozen: ReleaseFlag[] = [];
    for (const id of ids) {
      const draft = getDraft(id);
      if (!draft) return res.status(404).json({error: 'not_found', flagId: id});
      const wanted = requestedRevisions.get(id);
      if (wanted !== undefined && wanted !== draft.revision) {
        return res.status(409).json({
          error: 'stale_revision',
          message: `draft ${id} revision ${wanted} is stale; current is ${draft.revision}`,
          conflicts: [{flagId: id, kind: 'draft_changed', requestedRevision: wanted, currentRevision: draft.revision}],
        });
      }
      frozen.push(toReleaseFlag(draft));
    }

    const releaseId = `rel-${String(nextSequence).padStart(4, '0')}`;
    const baseRelease = currentRelease();
    const baseReleaseId = baseRelease.id;

    // Phase 1b: validation window. Drafts are intentionally NOT locked so the
    // workbench stays editable; the commit section re-checks everything.
    await afterFreeze({tentativeReleaseId: releaseId, baseReleaseId, flags: frozen});

    // ---- commit section: synchronous commit, atomic pointer flip ----
    const anchor = currentRelease();
    const conflicts: Array<{flagId?: string; kind: string; message: string; [key: string]: unknown}> = [];
    const conflictFlags = new Set<string>();
    const flagConflict = (flagId: string, entry: {kind: string; message: string; [key: string]: unknown}): void => {
      if (conflictFlags.has(flagId)) return; // minimal set: one entry per flag
      conflictFlags.add(flagId);
      conflicts.push({flagId, ...entry});
    };

    // Concurrency: another release landed while we were validating. Report
    // the minimal set: only flags the other release actually overrode that
    // we also intended to publish. Disjoint publishes auto-rebase.
    if (anchor.id !== baseReleaseId) {
      for (const flag of frozen) {
        const before = baseRelease.flags[flag.id];
        const after = anchor.flags[flag.id];
        if (after && (!before || before.revision !== after.revision)) {
          const draft = getDraft(flag.id);
          flagConflict(flag.id, {
            kind: 'release_advanced',
            message: `flag ${flag.id} was published in ${anchor.id} while validating`,
            baseReleaseId, otherReleaseId: anchor.id,
            committedRevision: after.revision,
            currentRevision: draft?.revision ?? null,
          });
        }
      }
    }

    // Draft changed under us: minimal per-flag conflict set (skip flags
    // already reported above; their entry already carries currentRevision).
    for (const frozenFlag of frozen) {
      if (conflictFlags.has(frozenFlag.id)) continue;
      const draft = getDraft(frozenFlag.id);
      if (!draft || draft.revision !== frozenFlag.revision) {
        flagConflict(frozenFlag.id, {
          kind: 'draft_changed',
          message: draft ? `draft ${draft.id} changed during validation` : `flag ${frozenFlag.id} was removed`,
          frozenRevision: frozenFlag.revision,
          currentRevision: draft?.revision ?? null,
        });
      }
    }

    if (conflicts.length > 0) {
      // The loser keeps its drafts; nothing was applied.
      return res.status(409).json({error: 'publish_conflict', baseReleaseId, currentReleaseId: anchor.id, conflicts});
    }

    // No conflicts: frozen revisions still match drafts, so rebuild from the
    // live drafts and rebase the batch onto the latest release snapshot.
    const override = frozen.map(flag => toReleaseFlag(getDraft(flag.id)!));
    const candidateFlags: Record<string, ReleaseFlag> = Object.fromEntries(Object.entries(anchor.flags));
    for (const flag of override) candidateFlags[flag.id] = flag;
    const effective = Object.values(candidateFlags);
    const violations = validateFlagSet(effective);
    if (violations.length > 0) {
      // All-or-nothing: no release created, pointer untouched, drafts untouched.
      return res.status(422).json({error: 'validation_failed', releaseId: currentReleaseId, violations});
    }

    const release = buildRelease(anchor, override, {
      note: typeof req.body?.note === 'string' ? req.body.note : '',
      createdBy: typeof req.body?.createdBy === 'string' ? req.body.createdBy : 'workbench',
      rollbackOf: null,
      parentId: anchor.id,
    });
    return res.status(201).json({release: summarize(release), currentReleaseId: release.id});
  });

  // ---------- rollback: appends a NEW release, history never moves ----------

  app.post('/api/releases/:id/rollback', (req, res) => {
    const target = getRelease(req.params.id);
    if (!target) return res.status(404).json({error: 'not_found'});
    if (target.id === currentReleaseId) {
      return res.status(409).json({error: 'already_current', currentReleaseId});
    }
    const release = buildRelease(target, Object.values(target.flags), {
      note: typeof req.body?.note === 'string' ? req.body.note : `rollback to ${target.id}`,
      createdBy: typeof req.body?.createdBy === 'string' ? req.body.createdBy : 'workbench',
      rollbackOf: target.id,
      parentId: currentReleaseId,
    });
    res.status(201).json({release: summarize(release), currentReleaseId: release.id});
  });

  // ---------- audit + reader API ----------

  app.get('/api/releases', (_req, res) =>
    res.json({currentReleaseId, releases: releases.map(summarize)}));

  app.get('/api/releases/:id', (req, res) => {
    const release = getRelease(req.params.id);
    if (!release) return res.status(404).json({error: 'not_found'});
    const summary = summarize(release);
    // ?full=1 exposes the complete historical flag content for audits.
    if (req.query.full === '1' || req.query.full === 'true') {
      return res.json({release: {...summary, flags: release.flags}});
    }
    res.json({release: summary});
  });

  // Readers resolve the pointer exactly once; every flag in the response
  // belongs to the same release snapshot.
  app.get('/api/evaluate', (req, res) => {
    const release = currentRelease();
    const env = typeof req.query.env === 'string' ? req.query.env : 'dev';
    const flagId = typeof req.query.flag === 'string' ? req.query.flag : undefined;
    const ids = flagId ? [flagId] : Object.keys(release.flags);
    if (flagId && !release.flags[flagId]) return res.status(404).json({error: 'not_found', releaseId: release.id});

    const flags = ids.map(id => {
      const flag = release.flags[id];
      const {pairs} = parseRules(flag.content);
      const active = flag.environments.includes(env);
      return {
        id: flag.id,
        name: flag.name,
        revision: flag.revision,
        active,
        environments: [...flag.environments],
        dependencies: [...flag.dependencies],
        rules: Object.fromEntries(pairs),
      };
    });
    res.json({releaseId: release.id, sequence: release.sequence, evaluatedAt: new Date().toISOString(), environment: env, flags});
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
