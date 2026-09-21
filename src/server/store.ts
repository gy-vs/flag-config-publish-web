// In-memory domain store for the feature-rules workbench.
//
// Invariants implemented here:
//  - drafts are mutable, each edit bumps an optimistic-lock revision;
//  - releases are immutable snapshots, history is append-only;
//  - exactly one release is active (single pointer switch);
//  - publish/rollback never mutate drafts;
//  - publish = freeze revisions -> validate closure/env -> atomic CAS commit.

export type DraftState = 'active' | 'disabled';

export interface Draft {
  id: string;
  name: string;
  revision: number;
  content: string;
  state: DraftState;
  envs: string[];
  dependsOn: string[];
  updatedAt: string;
}

export interface ReleaseMember {
  id: string;
  name: string;
  revision: number;
  content: string;
  state: DraftState;
  envs: string[];
  dependsOn: string[];
}

export interface Release {
  id: string;
  createdAt: string;
  note: string;
  environment: string;
  kind: 'publish' | 'rollback';
  /** Release that was active when this one was created. */
  parentId: string | null;
  /** For rollback releases: the historical release whose snapshot was restored. */
  rolledBackFrom?: string;
  members: ReleaseMember[];
}

export interface Store {
  envs: string[];
  drafts: Map<string, Draft>;
  releases: Release[];
  activeReleaseId: string;
  seq: number;
}

export function snapshotMember(draft: Draft): ReleaseMember {
  const {updatedAt: _updatedAt, ...member} = draft;
  return structuredClone(member);
}

export function createStore(): Store {
  const now = new Date(0).toISOString();
  const seed: Draft[] = [
    {
      id: 'alpha',
      name: 'Primary evaluation rules',
      revision: 3,
      content: 'evaluation rules: alpha\nstate: active',
      state: 'active',
      envs: ['prod', 'staging'],
      dependsOn: ['beta'],
      updatedAt: now,
    },
    {
      id: 'beta',
      name: 'Secondary evaluation rules',
      revision: 5,
      content: 'evaluation rules: beta\nstate: review',
      state: 'disabled',
      envs: ['staging'],
      dependsOn: [],
      updatedAt: new Date(1000).toISOString(),
    },
  ];

  const store: Store = {
    envs: ['prod', 'staging', 'dev'],
    drafts: new Map(seed.map((draft) => [draft.id, structuredClone(draft)])),
    releases: [],
    activeReleaseId: '',
    seq: 0,
  };

  // Baseline release: the complete snapshot the world starts in.
  const baseline: Release = {
    id: 'rel-0',
    createdAt: new Date(0).toISOString(),
    note: 'baseline release',
    environment: 'prod',
    kind: 'publish',
    parentId: null,
    members: seed.map(snapshotMember),
  };
  store.releases.push(baseline);
  store.activeReleaseId = baseline.id;
  return store;
}

export function nextId(store: Store, prefix: string): string {
  store.seq += 1;
  return `${prefix}-${store.seq}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type Issue =
  | {code: 'empty_selection'}
  | {code: 'environment_unknown'; environment: string; allowedEnvs: string[]}
  | {code: 'unknown_flag'; flagId: string}
  | {code: 'unknown_dependency'; flagId: string; dependencyId: string}
  | {code: 'missing_dependency'; flagId: string; dependencyId: string}
  | {code: 'environment_denied'; flagId: string; environment: string; allowedEnvs: string[]}
  | {code: 'dependency_cycle'; cycle: string[]};

export interface FrozenPlan {
  /** Deep copies taken synchronously; validation observes exactly these. */
  members: Draft[];
}

/**
 * Validates a frozen plan against the store as it existed at freeze time.
 * Returns every issue found (partial-invalid publishes must report the whole
 * set, then fail as a unit).
 */
export function validatePlan(store: Store, frozen: FrozenPlan, environment: string): Issue[] {
  const issues: Issue[] = [];
  const memberIds = new Set(frozen.members.map((member) => member.id));
  const frozenById = new Map(frozen.members.map((member) => [member.id, member]));

  if (frozen.members.length === 0) {
    issues.push({code: 'empty_selection'});
  }
  if (!store.envs.includes(environment)) {
    issues.push({code: 'environment_unknown', environment, allowedEnvs: [...store.envs]});
  }

  // Dependency closure, evaluated against the frozen snapshot.
  // Every flag reachable from the selection must either ship in this release
  // (be a frozen member) or refer to an existing draft; the closure itself
  // must be fully included in the publish set.
  const closure = new Set<string>();
  const stack: Array<{id: string; via: string | null}> = [
    ...[...memberIds].map((id) => ({id, via: null})),
  ];
  while (stack.length > 0) {
    const {id, via} = stack.pop()!;
    if (closure.has(id)) continue;
    closure.add(id);

    const node = frozenById.get(id) ?? store.drafts.get(id);
    if (!node) {
      // Reached through another flag's edge to a deleted/unknown draft.
      if (via) issues.push({code: 'unknown_dependency', flagId: via, dependencyId: id});
      continue;
    }
    for (const depId of node.dependsOn) {
      if (closure.has(depId)) continue;
      if (!store.drafts.has(depId)) {
        issues.push({code: 'unknown_dependency', flagId: id, dependencyId: depId});
        closure.add(depId);
        continue;
      }
      if (!memberIds.has(depId)) {
        // Reachable dependency outside the selection: minimal missing set.
        issues.push({code: 'missing_dependency', flagId: id, dependencyId: depId});
      }
      stack.push({id: depId, via: id});
    }
  }

  // Environment constraints for every flag in the publish set.
  if (store.envs.includes(environment)) {
    for (const member of frozen.members) {
      if (!member.envs.includes(environment)) {
        issues.push({
          code: 'environment_denied',
          flagId: member.id,
          environment,
          allowedEnvs: [...member.envs],
        });
      }
    }
  }

  // Cycle detection over the closure subgraph (Tarjan SCC).
  for (const cycle of findCycles(store, closure)) {
    issues.push({code: 'dependency_cycle', cycle});
  }

  return dedupeIssues(issues);
}

function findCycles(store: Store, nodes: Set<string>): string[][] {
  const indexById = new Map<string, number>();
  const lowById = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];
  let counter = 0;

  const visit = (id: string): void => {
    indexById.set(id, counter);
    lowById.set(id, counter);
    counter += 1;
    stack.push(id);
    onStack.add(id);
    const node = store.drafts.get(id);
    for (const depId of node?.dependsOn ?? []) {
      if (!nodes.has(depId)) continue;
      if (!indexById.has(depId)) {
        visit(depId);
        lowById.set(id, Math.min(lowById.get(id)!, lowById.get(depId)!));
      } else if (onStack.has(depId)) {
        lowById.set(id, Math.min(lowById.get(id)!, indexById.get(depId)!));
      }
    }
    if (lowById.get(id) === indexById.get(id)) {
      const component: string[] = [];
      for (;;) {
        const member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
        if (member === id) break;
      }
      // SCC of size > 1 is a cycle; size 1 with a self-edge is also a cycle.
      const hasSelfLoop = (nodeId: string): boolean =>
        store.drafts.get(nodeId)?.dependsOn.includes(nodeId) ?? false;
      if (component.length > 1 || hasSelfLoop(id)) {
        cycles.push(component.reverse());
      }
    }
  };

  for (const id of nodes) {
    if (store.drafts.has(id) && !indexById.has(id)) visit(id);
  }
  return cycles;
}

function issueKey(issue: Issue): string {
  return JSON.stringify(issue);
}

function dedupeIssues(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  const result: Issue[] = [];
  for (const issue of issues) {
    const key = issueKey(issue);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(issue);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

export interface DraftChangedConflict {
  kind: 'draft_changed';
  flagId: string;
  expectedRevision: number;
  currentRevision: number | null; // null => draft deleted during validation
}

export interface ReleaseMovedConflict {
  kind: 'would_be_removed' | 'reintroduced' | 'revised';
  flagId: string;
  baseRevision?: number;
  activeRevision?: number;
  frozenRevision?: number;
}

/**
 * Minimal conflict set for a losing publisher, scoped to that publisher's
 * footprint (base = release captured at request start, active = at commit):
 *  - revised:          flag in frozen and active with a different revision;
 *  - would_be_removed: flag outside frozen that was added in active after base
 *                      (the loser's release would silently drop it);
 *  - reintroduced:     flag in frozen that base shipped but active dropped
 *                      (the loser would resurrect a change the winner undid).
 */
export function diffAgainstActive(
  frozen: {members: Array<Pick<Draft, 'id' | 'revision'>>},
  baseRelease: Release,
  activeRelease: Release,
): ReleaseMovedConflict[] {
  if (baseRelease.id === activeRelease.id) return [];
  const conflicts: ReleaseMovedConflict[] = [];
  const frozenById = new Map(frozen.members.map((member) => [member.id, member]));
  const baseById = new Map(baseRelease.members.map((member) => [member.id, member]));
  const activeById = new Map(activeRelease.members.map((member) => [member.id, member]));

  for (const member of frozen.members) {
    const active = activeById.get(member.id);
    const base = baseById.get(member.id);
    if (active && active.revision !== member.revision) {
      conflicts.push({
        kind: 'revised',
        flagId: member.id,
        baseRevision: base?.revision,
        activeRevision: active.revision,
        frozenRevision: member.revision,
      });
    } else if (!active && base) {
      conflicts.push({
        kind: 'reintroduced',
        flagId: member.id,
        baseRevision: base.revision,
        frozenRevision: member.revision,
      });
    }
  }
  for (const active of activeRelease.members) {
    if (frozenById.has(active.id)) continue;
    const base = baseById.get(active.id);
    // Not in the frozen set and present in active: the loser's release would
    // drop it. Whether it was already in base (revision may differ) or the
    // winner just added it, the flag must be named in the conflict set.
    conflicts.push({
      kind: 'would_be_removed',
      flagId: active.id,
      baseRevision: base?.revision,
      activeRevision: active.revision,
    });
  }
  return conflicts;
}

// ---------------------------------------------------------------------------
// Evaluation snapshot
// ---------------------------------------------------------------------------

export interface EvaluatedFlag extends ReleaseMember {
  on: boolean;
}

/**
 * Pure function over a release snapshot: readers never observe a mix of
 * releases because the caller captures one release object synchronously.
 */
export function evaluateRelease(release: Release, environment: string): Map<string, EvaluatedFlag> {
  const byId = new Map(release.members.map((member) => [member.id, member] as const));
  const onCache = new Map<string, boolean>();

  const isOn = (id: string, guard: Set<string>): boolean => {
    const cached = onCache.get(id);
    if (cached !== undefined) return cached;
    const member = byId.get(id);
    // A dependency missing from this snapshot cannot be satisfied.
    if (!member) return false;
    if (guard.has(id)) return false; // cycle inside snapshot: treat as off
    guard.add(id);
    const depsOn = member.dependsOn.every((depId) => isOn(depId, guard));
    guard.delete(id);
    const on = member.state === 'active' && member.envs.includes(environment) && depsOn;
    onCache.set(id, on);
    return on;
  };

  const result = new Map<string, EvaluatedFlag>();
  for (const member of release.members) {
    result.set(member.id, {...member, on: isOn(member.id, new Set())});
  }
  return result;
}
