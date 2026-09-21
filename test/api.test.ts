import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';

type App = ReturnType<typeof createApp>;

async function updateDraft(app: App, id: string, patch: Record<string, unknown>, revision?: number) {
  const rev = revision ?? (await request(app).get(`/api/flags/${id}`)).body.revision;
  const res = await request(app).put(`/api/flags/${id}`).send({revision: rev, ...patch});
  return res;
}

function publish(app: App, body: Record<string, unknown> = {}) {
  return request(app).post('/api/releases/publish').send(body);
}

async function publishAndBlock(
  body: Record<string, unknown>,
  during: () => Promise<void>,
) {
  let release: ((value?: unknown) => void) | null = null;
  const gate = new Promise<void>(resolve => {
    release = () => resolve();
  });
  let entered = false;
  const testApp = createApp({
    afterFreeze: async () => {
      if (entered) return; // nested publishes use the default fast path
      entered = true;
      await during();
      await gate;
    },
  });
  const pending = request(testApp).post('/api/releases/publish').send(body);
  // wait until the outer request has frozen its revisions
  await new Promise(resolve => setTimeout(resolve, 30));
  return {
    testApp,
    async resume() {
      release!(null);
      return pending;
    },
  };
}

describe('release publishing', () => {
  it('publishes multiple drafts as one atomic release', async () => {
    const app = createApp();
    const before = await request(app).get('/api/evaluate').expect(200);
    expect(before.body.releaseId).toBe('rel-0001');

    await updateDraft(app, 'alpha', {content: 'rule.a: changed'});
    await updateDraft(app, 'beta', {content: 'rule.c: changed-too'});
    const res = await publish(app, {flags: [{id: 'alpha'}, {id: 'beta'}], note: 'batch'});
    expect(res.status).toBe(201);
    expect(res.body.release.id).toBe('rel-0002');
    expect(res.body.release.parentId).toBe('rel-0001');
    expect(Object.keys(res.body.release.flags).sort()).toEqual(['alpha', 'beta']);

    const after = await request(app).get('/api/evaluate').expect(200);
    expect(after.body.releaseId).toBe('rel-0002');
    const rules = Object.fromEntries(after.body.flags.map((f: {id: string; rules: unknown}) => [f.id, f.rules]));
    expect(rules.alpha).toEqual({'rule.a': 'changed'});
    expect(rules.beta).toEqual({'rule.c': 'changed-too'});
  });

  it('rejects cyclic dependency validation without changing the release', async () => {
    const app = createApp();
    await updateDraft(app, 'beta', {dependencies: ['alpha']}); // alpha -> beta -> alpha
    const res = await publish(app);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('validation_failed');
    const codes = res.body.violations.map((v: {code: string}) => v.code);
    expect(codes).toContain('cyclic_dependency');
    const cycleViolation = res.body.violations.find((v: {code: string; path?: string[]}) => v.code === 'cyclic_dependency' && v.path) as {path: string[]};
    expect(cycleViolation.path).toContain('alpha');
    expect(cycleViolation.path).toContain('beta');

    // nothing applied
    const live = await request(app).get('/api/evaluate');
    expect(live.body.releaseId).toBe('rel-0001');
    expect(live.body.flags.find((f: {id: string}) => f.id === 'beta').dependencies).toEqual([]);
  });

  it('rejects when only part of the batch is invalid (all-or-nothing)', async () => {
    const app = createApp();
    await updateDraft(app, 'alpha', {content: 'rule.a: valid'});
    await updateDraft(app, 'beta', {content: ''}); // empty rules
    const res = await publish(app);
    expect(res.status).toBe(422);
    expect(res.body.violations.map((v: {code: string}) => v.code)).toContain('empty_rules');

    // pointer, release history and drafts are all untouched
    const live = await request(app).get('/api/evaluate');
    expect(live.body.releaseId).toBe('rel-0001');
    expect(live.body.flags.find((f: {id: string}) => f.id === 'alpha').rules).toEqual({'rule.a': 'on', 'rule.b': '42'});
    const history = await request(app).get('/api/releases');
    expect(history.body.releases).toHaveLength(1);
    const betaDraft = await request(app).get('/api/flags/beta');
    expect(betaDraft.body.content).toBe(''); // loser keeps the draft
  });

  it('enforces environment constraints across the dependency closure', async () => {
    const app = createApp();
    await updateDraft(app, 'beta', {environments: ['dev']}); // alpha needs beta in prod too
    const fail = await publish(app);
    expect(fail.status).toBe(422);
    expect(fail.body.violations.some((v: {code: string}) => v.code === 'environment_unsatisfied')).toBe(true);

    // removing the dependency resolves the constraint and release goes live
    await updateDraft(app, 'alpha', {dependencies: []});
    const ok = await publish(app);
    expect(ok.status).toBe(201);
    const live = await request(app).get('/api/evaluate?env=prod');
    expect(live.body.flags.find((f: {id: string}) => f.id === 'alpha').dependencies).toEqual([]);
    expect(live.body.flags.find((f: {id: string}) => f.id === 'beta').active).toBe(false);
  });

  it('rejects missing dependencies in the closure but allows deleting a dependency', async () => {
    const app = createApp();
    await updateDraft(app, 'alpha', {dependencies: ['ghost']});
    const fail = await publish(app);
    expect(fail.status).toBe(422);
    expect(fail.body.violations.some((v: {code: string; dependency?: string}) => v.code === 'missing_dependency' && v.dependency === 'ghost')).toBe(true);

    // delete the dependency via a follow-up edit, then publish succeeds
    const alphaDraft = await request(app).get('/api/flags/alpha');
    await request(app).put('/api/flags/alpha')
      .send({revision: alphaDraft.body.revision, dependencies: [], content: alphaDraft.body.content})
      .expect(200);
    const ok = await publish(app);
    expect(ok.status).toBe(201);
    const live = await request(app).get('/api/evaluate');
    expect(live.body.flags.find((f: {id: string}) => f.id === 'alpha').dependencies).toEqual([]);
  });

  it('fails the publish with a minimal conflict set when a draft changes during validation', async () => {
    const blocked = await publishAndBlock( {flags: [{id: 'alpha'}, {id: 'beta'}]}, async () => {
      // beta is edited while alpha+beta are mid-validation
      const beta = await request(blocked.testApp).get('/api/flags/beta');
      await request(blocked.testApp).put('/api/flags/beta')
        .send({revision: beta.body.revision, content: 'rule.c: mutated-midflight'})
        .expect(200);
    });

    const res = await blocked.resume();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('publish_conflict');
    expect(res.body.conflicts).toHaveLength(1);
    expect(res.body.conflicts[0]).toMatchObject({flagId: 'beta', kind: 'draft_changed'});

    // the loser keeps its drafts; nothing was applied
    const live = await request(blocked.testApp).get('/api/evaluate');
    expect(live.body.releaseId).toBe('rel-0001');
    const betaDraft = await request(blocked.testApp).get('/api/flags/beta');
    expect(betaDraft.body.content).toBe('rule.c: mutated-midflight');
  });

  it('rejects explicit stale revisions before validation starts', async () => {
    const app = createApp();
    const res = await publish(app, {flags: [{id: 'alpha', revision: 999}]});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('stale_revision');
    expect(res.body.conflicts[0]).toMatchObject({flagId: 'alpha', kind: 'draft_changed'});
  });

  it('gives the second committer the minimal conflicting flags when two publishes race', async () => {
    const blocked = await publishAndBlock( {flags: [{id: 'alpha'}, {id: 'beta'}]}, async () => {
      // another workbench publishes alpha while we are validating alpha+beta
      const alpha = await request(blocked.testApp).get('/api/flags/alpha');
      await request(blocked.testApp).put('/api/flags/alpha')
        .send({revision: alpha.body.revision, content: 'rule.a: won-the-race'})
        .expect(200);
      const inner = await publish(blocked.testApp, {flags: [{id: 'alpha'}], note: 'winner'});
      expect(inner.status).toBe(201);
      expect(inner.body.release.id).toBe('rel-0002');
    });

    const loser = await blocked.resume();
    expect(loser.status).toBe(409);
    expect(loser.body.conflicts.map((c: {flagId: string}) => c.flagId)).toEqual(['alpha']);
    expect(loser.body.conflicts[0].kind).toBe('release_advanced');

    // publishing never mutates drafts, so the winner's draft content is preserved
    const alphaDraft = await request(blocked.testApp).get('/api/flags/alpha');
    expect(alphaDraft.body.content).toBe('rule.a: won-the-race');
    const history = await request(blocked.testApp).get('/api/releases');
    expect(history.body.releases.map((r: {id: string}) => r.id)).toEqual(['rel-0001', 'rel-0002']);
  });

  it('auto-rebases when a racing publish touches a disjoint flag set', async () => {
    const blocked = await publishAndBlock( {flags: [{id: 'alpha'}]}, async () => {
      const beta = await request(blocked.testApp).get('/api/flags/beta');
      await request(blocked.testApp).put('/api/flags/beta')
        .send({revision: beta.body.revision, content: 'rule.c: parallel'})
        .expect(200);
      await publish(blocked.testApp, {flags: [{id: 'beta'}]}).expect(201);
    });
    const res = await blocked.resume();
    expect(res.status).toBe(201);
    expect(res.body.release.parentId).toBe('rel-0002');
    const live = await request(blocked.testApp).get('/api/evaluate');
    expect(live.body.flags.find((f: {id: string}) => f.id === 'alpha').rules).toEqual({'rule.a': 'on', 'rule.b': '42'});
    expect(live.body.flags.find((f: {id: string}) => f.id === 'beta').rules).toEqual({'rule.c': 'parallel'});
  });

  it('rolls back by creating a new release and keeps history auditable', async () => {
    const app = createApp();
    await updateDraft(app, 'alpha', {content: 'rule.a: v2'});
    const r2 = await publish(app, {note: 'second'});
    expect(r2.body.release.id).toBe('rel-0002');

    const rollback = await request(app).post('/api/releases/rel-0001/rollback').send({});
    expect(rollback.status).toBe(201);
    expect(rollback.body.release.id).toBe('rel-0003');
    expect(rollback.body.release.rollbackOf).toBe('rel-0001');
    expect(rollback.body.release.parentId).toBe('rel-0002'); // history chain intact
    expect(rollback.body.currentReleaseId).toBe('rel-0003');

    const history = await request(app).get('/api/releases');
    expect(history.body.currentReleaseId).toBe('rel-0003');
    expect(history.body.releases.map((r: {id: string}) => r.id)).toEqual(['rel-0001', 'rel-0002', 'rel-0003']);

    const live = await request(app).get('/api/evaluate');
    expect(live.body.releaseId).toBe('rel-0003');
    expect(live.body.flags.find((f: {id: string}) => f.id === 'alpha').rules).toEqual({'rule.a': 'on', 'rule.b': '42'});

    // historical releases remain readable byte-for-byte
    const old = await request(app).get('/api/releases/rel-0002?full=1');
    expect(old.body.release.flags.alpha.revision).toBe(r2.body.release.flags.alpha.revision);
    expect(old.body.release.flags.alpha.content).toBe('rule.a: v2');
  });

  it('supports editing drafts after rollback and publishing again on top', async () => {
    const app = createApp();
    await updateDraft(app, 'alpha', {content: 'rule.a: v2'});
    await publish(app);
    await request(app).post('/api/releases/rel-0001/rollback').send({}).expect(201);

    // drafts still hold the post-v2 revision; edit from current revision and publish
    const draft = await request(app).get('/api/flags/alpha');
    expect(draft.body.content).toBe('rule.a: v2');
    const res = await request(app).put('/api/flags/alpha')
      .send({revision: draft.body.revision, content: 'rule.a: v3-after-rollback'})
      .expect(200);
    expect(res.body.revision).toBe(draft.body.revision + 1);
    const published = await publish(app, {flags: [{id: 'alpha'}]});
    expect(published.status).toBe(201);
    expect(published.body.release.rollbackOf).toBe(null);
    const live = await request(app).get('/api/evaluate');
    expect(live.body.flags.find((f: {id: string}) => f.id === 'alpha').rules).toEqual({'rule.a': 'v3-after-rollback'});
  });

  it('never lets a reader observe a torn release at the switch instant', async () => {
    let release: ((value?: unknown) => void) | null = null;
    const gate = new Promise<void>(resolve => {
      release = () => resolve();
    });
    const app = createApp({afterFreeze: () => gate});

    await updateDraft(app, 'alpha', {content: 'rule.a: new'});
    await updateDraft(app, 'beta', {content: 'rule.c: new'});
    const switching = publish(app, {note: 'switch'});
    await new Promise(resolve => setTimeout(resolve, 30));

    const expectConsistentSnapshot = async (): Promise<string> => {
      const res = await request(app).get('/api/evaluate');
      // the whole response must match one complete, auditable release snapshot
      const snapshot = await request(app).get(`/api/releases/${res.body.releaseId}`).expect(200);
      expect(res.body.flags).toHaveLength(Object.keys(snapshot.body.release.flags).length);
      for (const flag of res.body.flags as Array<{id: string; revision: number}>) {
        expect(snapshot.body.release.flags[flag.id].revision).toBe(flag.revision);
      }
      return res.body.releaseId;
    };

    // wave 1: switch is pending — every reader must see the COMPLETE old release
    const before = await Promise.all(Array.from({length: 10}, () => expectConsistentSnapshot()));
    expect(new Set(before)).toEqual(new Set(['rel-0001']));

    release!(null);
    await switching;

    // wave 2: pointer flipped — every reader must see the COMPLETE new release
    const after = await Promise.all(Array.from({length: 10}, () => expectConsistentSnapshot()));
    expect(new Set(after)).toEqual(new Set(['rel-0002']));

    const finalLive = await request(app).get('/api/evaluate');
    expect(finalLive.body.releaseId).toBe('rel-0002');
    expect(finalLive.body.flags.find((f: {id: string}) => f.id === 'alpha').rules).toEqual({'rule.a': 'new'});
    expect(finalLive.body.flags.find((f: {id: string}) => f.id === 'beta').rules).toEqual({'rule.c': 'new'});
  });
});
