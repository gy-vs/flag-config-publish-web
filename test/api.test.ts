import {describe, expect, it} from 'vitest';
import request from 'supertest';
import type {Response} from 'superagent';
import {createApp} from '../src/server/index';

interface Issue {
  code: string;
  [key: string]: unknown;
}

function put(app: ReturnType<typeof createApp>, id: string, body: Record<string, unknown>) {
  return request(app)
    .get(`/api/flags/${id}`)
    .expect(200)
    .then((current: Response) =>
      request(app)
        .put(`/api/flags/${id}`)
        .send({revision: current.body.revision, ...body}),
    );
}

async function evaluate(app: ReturnType<typeof createApp>, environment?: string) {
  const response = await request(app)
    .post('/api/evaluate')
    .send(environment ? {environment} : {})
    .expect(200);
  return response.body as {releaseId: string; flags: Array<{id: string; revision: number; on: boolean}>};
}

function publish(
  app: ReturnType<typeof createApp>,
  flagIds: string[],
  extra: Record<string, unknown> = {},
) {
  return request(app)
    .post('/api/releases/publish')
    .send({flagIds, environment: 'staging', ...extra});
}

async function createFlag(
  app: ReturnType<typeof createApp>,
  id: string,
  body: Record<string, unknown> = {},
) {
  return request(app)
    .post('/api/flags')
    .send({id, name: id, content: `rules: ${id}`, dependsOn: [], ...body})
    .expect(201);
}

// Fires a publish immediately (supertest only sends on .then/end), resolving
// once the server responds. Used to control request-vs-edit ordering.
function startPublish(
  app: ReturnType<typeof createApp>,
  body: Record<string, unknown>,
): Promise<{status: number; body: any}> {
  return new Promise((resolve, reject) => {
    request(app)
      .post('/api/releases/publish')
      .send({flagIds: [], environment: 'staging', ...body})
      .end((error: Error | null, response: Response) => {
        if (error && !response) reject(error);
        else resolve({status: response.status, body: response.body});
      });
  });
}

function releaseCount(body: {releases: unknown[]}) {
  return body.releases.length;
}

describe('service compatibility', () => {
  it('loads and conditionally updates a record', async () => {
    const app = createApp();
    const before = await request(app).get('/api/flags/alpha').expect(200);
    await request(app)
      .put('/api/flags/alpha')
      .send({content: 'updated', revision: before.body.revision})
      .expect(200);
    await request(app)
      .put('/api/flags/alpha')
      .send({content: 'stale', revision: before.body.revision})
      .expect(409);
  });

  it('starts with a complete baseline release', async () => {
    const app = createApp();
    const state = await request(app).get('/api/state').expect(200);
    expect(state.body.activeReleaseId).toBe('rel-0');
    expect(state.body.releases).toHaveLength(1);
    const result = await evaluate(app);
    expect(result.releaseId).toBe('rel-0');
    expect(result.flags.map((flag) => flag.id).sort()).toEqual(['alpha', 'beta']);
  });
});

describe('atomic publish', () => {
  it('publishes multiple interdependent drafts as one release without bumping draft revisions', async () => {
    const app = createApp();
    await put(app, 'beta', {state: 'active'});
    const beforeAlpha = (await request(app).get('/api/flags/alpha').expect(200)).body;
    const beforeBeta = (await request(app).get('/api/flags/beta').expect(200)).body;

    const response = await publish(app, ['alpha', 'beta'], {note: 'ship both'}).expect(201);
    expect(response.body.release.kind).toBe('publish');
    expect(response.body.release.members.map((m: {id: string}) => m.id).sort()).toEqual([
      'alpha',
      'beta',
    ]);

    const result = await evaluate(app);
    expect(result.releaseId).toBe(response.body.release.id);
    expect(Object.fromEntries(result.flags.map((flag) => [flag.id, flag.on]))).toEqual({
      alpha: true,
      beta: true,
    });

    // Drafts themselves are untouched by publishing.
    const afterAlpha = (await request(app).get('/api/flags/alpha').expect(200)).body;
    const afterBeta = (await request(app).get('/api/flags/beta').expect(200)).body;
    expect(afterAlpha.revision).toBe(beforeAlpha.revision);
    expect(afterBeta.revision).toBe(beforeBeta.revision);
  });

  it('rejects a publish set that is not closed under dependencies (minimal missing set)', async () => {
    const app = createApp();
    const response = await publish(app, ['alpha']).expect(422);
    const issues = response.body.issues as Issue[];
    expect(issues).toEqual([
      expect.objectContaining({code: 'missing_dependency', flagId: 'alpha', dependencyId: 'beta'}),
    ]);
    const state = await request(app).get('/api/state').expect(200);
    expect(state.body.activeReleaseId).toBe('rel-0');
    expect(releaseCount(state.body)).toBe(1);
  });

  it('rejects an unknown environment and empty selection', async () => {
    const app = createApp();
    const empty = await publish(app, [], {environment: 'staging'}).expect(422);
    expect(empty.body.issues.map((i: Issue) => i.code)).toContain('empty_selection');

    const badEnv = await publish(app, ['alpha', 'beta'], {environment: 'moon'}).expect(422);
    expect(badEnv.body.issues.map((i: Issue) => i.code)).toContain('environment_unknown');
    expect((await request(app).get('/api/state')).body.activeReleaseId).toBe('rel-0');
  });
});

describe('validation failures are all-or-nothing', () => {
  it('detects dependency cycles (2-cycle and self-loop)', async () => {
    const app = createApp();
    await put(app, 'beta', {dependsOn: ['alpha']});
    const response = await publish(app, ['alpha', 'beta']).expect(422);
    const cycleIssue = (response.body.issues as Issue[]).find((i) => i.code === 'dependency_cycle');
    expect(cycleIssue).toBeTruthy();
    expect((cycleIssue!.cycle as string[]).sort()).toEqual(['alpha', 'beta']);
    expect((await request(app).get('/api/state')).body.activeReleaseId).toBe('rel-0');

    // Self loop.
    const app2 = createApp();
    await createFlag(app2, 'solo');
    await put(app2, 'solo', {dependsOn: ['solo']});
    const self = await publish(app2, ['solo']).expect(422);
    expect((self.body.issues as Issue[]).map((i) => i.code)).toContain('dependency_cycle');
  });

  it('reports every problem at once (partial invalid) and switches nothing', async () => {
    const app = createApp();
    // beta points at a deleted/unknown flag; beta is also not allowed in prod.
    await put(app, 'beta', {dependsOn: ['ghost']});
    const response = await request(app)
      .post('/api/releases/publish')
      .send({flagIds: ['alpha', 'beta'], environment: 'prod'})
      .expect(422);
    const codes = (response.body.issues as Issue[]).map((issue) => issue.code);
    expect(codes).toContain('unknown_dependency');
    expect(codes).toContain('environment_denied');

    const state = (await request(app).get('/api/state').expect(200)).body;
    expect(state.activeReleaseId).toBe('rel-0');
    expect(state.releases).toHaveLength(1);
  });

  it('fails when an expected revision does not match the frozen draft (stale client)', async () => {
    const app = createApp();
    const response = await request(app)
      .post('/api/releases/publish')
      .send({
        flagIds: ['alpha', 'beta'],
        environment: 'staging',
        expectedRevisions: {alpha: 999, beta: 5},
      })
      .expect(400);
    expect(response.body.error).toBe('stale_request');
    expect(response.body.conflicts[0].flagId).toBe('alpha');
  });
});

describe('draft changing during validation', () => {
  it('keeps the edited draft and returns only the drifted flag as conflict', async () => {
    const app = createApp();
    const started = startPublish(app, {
      flagIds: ['alpha', 'beta'],
      expectedRevisions: {alpha: 3, beta: 5},
      validationDelayMs: 200,
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    await put(app, 'beta', {content: 'changed mid-validation'}); // beta r6

    const response = await started;
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('publish_conflict');
    expect(response.body.conflicts).toEqual([
      {kind: 'draft_changed', flagId: 'beta', expectedRevision: 5, currentRevision: 6},
    ]);

    // Nothing switched, no release written, loser's draft edit is preserved.
    const state = (await request(app).get('/api/state').expect(200)).body;
    expect(state.activeReleaseId).toBe('rel-0');
    expect(state.releases).toHaveLength(1);
    const beta = (await request(app).get('/api/flags/beta').expect(200)).body;
    expect(beta.revision).toBe(6);
    expect(beta.content).toBe('changed mid-validation');

    // Retry with the refreshed revision succeeds.
    const retry = await publish(app, ['alpha', 'beta'], {
      expectedRevisions: {alpha: 3, beta: 6},
    }).expect(201);
    expect(retry.body.release.id).not.toBe('rel-0');
  });

  it('reports currentRevision null when the draft is deleted during validation', async () => {
    const app = createApp();
    await createFlag(app, 'gamma');
    const started = startPublish(app, {flagIds: ['gamma'], validationDelayMs: 150});
    await new Promise((resolve) => setTimeout(resolve, 50));
    await request(app).delete('/api/flags/gamma').expect(204);
    const response = await started;
    expect(response.status).toBe(409);
    expect(response.body.conflicts).toEqual([
      {kind: 'draft_changed', flagId: 'gamma', expectedRevision: 1, currentRevision: null},
    ]);
    expect((await request(app).get('/api/state')).body.activeReleaseId).toBe('rel-0');
  });
});

describe('concurrent publishes', () => {
  it('the loser keeps its drafts and receives the minimal release-race conflict set, then retries', async () => {
    const app = createApp();
    await createFlag(app, 'gamma');
    await createFlag(app, 'delta');

    // B freezes gamma r1 + delta r2 first, validates slowly.
    await put(app, 'delta', {content: 'delta work'}); // delta r2
    const loser = startPublish(app, {
      flagIds: ['gamma', 'delta'],
      expectedRevisions: {gamma: 1, delta: 2},
      validationDelayMs: 250,
    });

    // A edits gamma to r2 and commits first.
    await new Promise((resolve) => setTimeout(resolve, 40));
    await put(app, 'gamma', {content: 'gamma work'}); // gamma r2
    await request(app)
      .post('/api/releases/publish')
      .send({
        flagIds: ['gamma'],
        environment: 'staging',
        expectedRevisions: {gamma: 2},
        validationDelayMs: 60,
      })
      .expect(201);

    const response = await loser;
    expect(response.status).toBe(409);
    expect(response.body.conflicts).toEqual([
      expect.objectContaining({
        kind: 'revised',
        flagId: 'gamma',
        frozenRevision: 1,
        activeRevision: 2,
      }),
    ]);
    // delta (the loser's own untouched work) is absent from the conflict set
    // and its draft is preserved.
    const delta = (await request(app).get('/api/flags/delta').expect(200)).body;
    expect(delta.revision).toBe(2);
    expect(delta.content).toBe('delta work');

    // Refresh + retry succeeds; the winner's gamma and the loser's delta ship together.
    const retry = await publish(app, ['gamma', 'delta'], {
      expectedRevisions: {gamma: 2, delta: 2},
    }).expect(201);
    expect(retry.body.release.members.map((m: {id: string}) => m.id).sort()).toEqual([
      'delta',
      'gamma',
    ]);
  });

  it('flags reintroduced and would_be_removed flags across diverging footprints', async () => {
    const app = createApp();
    await createFlag(app, 'gamma');
    await createFlag(app, 'delta');
    // Base release containing both.
    await publish(app, ['gamma', 'delta']).expect(201);

    // Loser freezes only gamma; winner ships only delta.
    const loser = startPublish(app, {flagIds: ['gamma'], validationDelayMs: 200});
    await new Promise((resolve) => setTimeout(resolve, 40));
    await request(app)
      .post('/api/releases/publish')
      .send({flagIds: ['delta'], environment: 'staging', validationDelayMs: 20})
      .expect(201);

    const response = await loser;
    expect(response.status).toBe(409);
    const kinds = Object.fromEntries(
      response.body.conflicts.map((c: {kind: string; flagId: string}) => [c.flagId, c.kind]),
    );
    expect(kinds.gamma).toBe('reintroduced'); // winner dropped it, loser would restore it
    expect(kinds.delta).toBe('would_be_removed'); // winner added it, loser would drop it
  });
});

describe('rollback', () => {
  it('creates a new release pointing at the historical snapshot and leaves history immutable', async () => {
    const app = createApp();
    await createFlag(app, 'gamma');
    await put(app, 'beta', {state: 'active'});
    const shipped = await publish(app, ['alpha', 'beta', 'gamma'], {note: 'big ship'}).expect(201);
    const shippedId = shipped.body.release.id;
    const historical = await request(app).get('/api/releases/rel-0').expect(200);

    const rollback = await request(app)
      .post('/api/releases/rel-0/rollback')
      .send({note: 'undo big ship'})
      .expect(201);
    expect(rollback.body.release.kind).toBe('rollback');
    expect(rollback.body.release.rolledBackFrom).toBe('rel-0');
    expect(rollback.body.release.id).not.toBe('rel-0');
    expect(rollback.body.release.id).not.toBe(shippedId);
    expect(rollback.body.release.members.map((m: {id: string}) => m.id).sort()).toEqual([
      'alpha',
      'beta',
    ]);

    // Pointer moved; evaluation serves the restored snapshot.
    const result = await evaluate(app);
    expect(result.releaseId).toBe(rollback.body.release.id);
    expect(result.flags.map((flag) => flag.id).sort()).toEqual(['alpha', 'beta']);
    expect(Object.fromEntries(result.flags.map((flag) => [flag.id, flag.on]))).toEqual({
      alpha: false, // beta was disabled again in the old snapshot
      beta: false,
    });

    // History is append-only and untouched: rel-0 bytes are identical.
    const after = await request(app).get('/api/releases/rel-0').expect(200);
    expect(after.body).toEqual(historical.body);
    const releases = (await request(app).get('/api/releases').expect(200)).body;
    expect(releases.map((r: {id: string}) => r.id)).toEqual([
      'rel-0',
      shippedId,
      rollback.body.release.id,
    ]);
  });

  it('supports editing drafts after rollback and publishing again', async () => {
    const app = createApp();
    await createFlag(app, 'gamma');
    await publish(app, ['gamma'], {note: 'gamma out'});
    await request(app).post('/api/releases/rel-0/rollback').expect(201);

    // Drafts were never touched by rollback; gamma draft is still editable.
    const edit = await put(app, 'gamma', {content: 'gamma revised'});
    expect(edit.status).toBe(200);
    const again = await publish(app, ['gamma'], {note: 'gamma out again'}).expect(201);
    expect(again.body.release.parentId).not.toBe('rel-0');
    const result = await evaluate(app);
    expect(result.releaseId).toBe(again.body.release.id);
    expect(result.flags.map((flag) => flag.id)).toEqual(['gamma']);
  });
});

describe('dependency deletion', () => {
  it('publishes a flag alone once its dependency edge is removed', async () => {
    const app = createApp();
    await put(app, 'alpha', {dependsOn: []});
    const response = await publish(app, ['alpha']).expect(201);
    expect(response.body.release.members.map((m: {id: string}) => m.id)).toEqual(['alpha']);
  });

  it('keeps deleted flags in historical releases but blocks new references', async () => {
    const app = createApp();
    await createFlag(app, 'gamma', {dependsOn: ['beta']});
    await request(app).delete('/api/flags/beta').expect(204);

    expect((await request(app).get('/api/flags/beta')).status).toBe(404);
    const blocked = await publish(app, ['gamma']).expect(422);
    expect((blocked.body.issues as Issue[]).map((i) => i.code)).toContain('unknown_dependency');

    // The old release snapshot remains complete and auditable.
    const rel0 = await request(app).get('/api/releases/rel-0').expect(200);
    expect(rel0.body.members.map((m: {id: string}) => m.id).sort()).toEqual(['alpha', 'beta']);
    // Evaluation still serves from the frozen snapshot.
    const result = await evaluate(app);
    expect(result.flags.map((flag) => flag.id).sort()).toEqual(['alpha', 'beta']);
  });
});

describe('reader switch instant', () => {
  it('every evaluation sees either the complete old release or the complete new one', async () => {
    const app = createApp();
    await createFlag(app, 'gamma');
    await put(app, 'gamma', {content: 'gamma live'});

    const vectors = new Map<string, string[]>();
    const seen = new Set<string>();
    const samples: Array<{releaseId: string; ids: string[]; phase: string}> = [];
    const deadline = Date.now() + 2000;

    const publishPromise = startPublish(app, {flagIds: ['gamma'], validationDelayMs: 250});
    const poll = async () => {
      while (Date.now() < deadline) {
        const result = await evaluate(app);
        const ids = result.flags.map((flag) => flag.id).sort();
        seen.add(result.releaseId);
        vectors.set(result.releaseId, ids);
        samples.push({releaseId: result.releaseId, ids, phase: 'during'});
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    const pollDone = poll();
    const shipped = await publishPromise;
    await pollDone;
    // Re-tag phases deterministically from the response's boundary.
    for (const sample of samples) {
      sample.phase = sample.releaseId === 'rel-0' ? 'during' : 'after';
    }

    // Exactly the two complete vectors were ever visible.
    expect(seen).toEqual(new Set(['rel-0', shipped.body.release.id]));
    expect(vectors.get('rel-0')).toEqual(['alpha', 'beta']);
    expect(vectors.get(shipped.body.release.id)).toEqual(['gamma']);
    for (const sample of samples) {
      expect(sample.ids).toEqual(vectors.get(sample.releaseId));
    }
    // Samples on both sides of the switch existed, and the sequence flipped at
    // most once (old -> new), never back and forth.
    expect(samples.some((sample) => sample.phase === 'during' && sample.releaseId === 'rel-0')).toBe(true);
    expect(samples.some((sample) => sample.phase === 'after' && sample.releaseId === shipped.body.release.id)).toBe(true);
    const order = samples.map((sample) => (sample.releaseId === 'rel-0' ? 0 : 1));
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i]).toBeGreaterThanOrEqual(order[i - 1]);
    }
  });

  it('environment gating is evaluated consistently from the single snapshot', async () => {
    const app = createApp();
    // staging: beta active -> alpha (depends beta) active; prod: beta not allowed.
    await put(app, 'beta', {state: 'active'});
    const shipped = await publish(app, ['alpha', 'beta']).expect(201);
    const staging = await evaluate(app, 'staging');
    expect(Object.fromEntries(staging.flags.map((flag) => [flag.id, flag.on]))).toEqual({
      alpha: true,
      beta: true,
    });
    const prod = await evaluate(app, 'prod');
    expect(prod.releaseId).toBe(shipped.body.release.id);
    expect(Object.fromEntries(prod.flags.map((flag) => [flag.id, flag.on]))).toEqual({
      alpha: false,
      beta: false,
    });
  });
});
