import {useCallback, useEffect, useMemo, useState} from 'react';
import {
  CheckCircle2,
  FlaskConical,
  GitBranch,
  History,
  Play,
  RotateCcw,
  Save,
  Send,
  XCircle,
} from 'lucide-react';

type Summary = {
  id: string;
  name: string;
  revision: number;
  state: 'active' | 'disabled';
  envs: string[];
  dependsOn: string[];
  updatedAt: string;
};
type Draft = Summary & {content: string};
type ReleaseSummary = {
  id: string;
  createdAt: string;
  note: string;
  environment: string;
  kind: 'publish' | 'rollback';
  parentId: string | null;
  rolledBackFrom?: string;
  members: Array<{id: string; revision: number}>;
};
type WorkbenchState = {
  envs: string[];
  activeReleaseId: string;
  drafts: Draft[];
  releases: ReleaseSummary[];
};
type Conflict =
  | {kind: 'draft_changed'; flagId: string; expectedRevision: number; currentRevision: number | null}
  | {kind: 'revised'; flagId: string; frozenRevision?: number; activeRevision?: number}
  | {kind: 'would_be_removed'; flagId: string; activeRevision?: number}
  | {kind: 'reintroduced'; flagId: string; frozenRevision?: number};

const conflictLabel: Record<Conflict['kind'], string> = {
  draft_changed: '验证期间草稿已变更',
  revised: '他人发布了新版本',
  would_be_removed: '你的发布会移除他人新发布的 flag',
  reintroduced: '你的发布会重新带回已被移除的 flag',
};

export default function App() {
  const [state, setState] = useState<WorkbenchState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editor, setEditor] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState('Ready');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [environment, setEnvironment] = useState('staging');
  const [note, setNote] = useState('');
  const [issues, setIssues] = useState<unknown[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [conflictRelease, setConflictRelease] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [evaluation, setEvaluation] = useState<{
    releaseId: string;
    environment: string;
    flags: Array<{id: string; revision: number; on: boolean; state: string}>;
  } | null>(null);
  const [newId, setNewId] = useState('');

  const refresh = useCallback(async () => {
    const response = await fetch('/api/state');
    const value = (await response.json()) as WorkbenchState;
    setState(value);
    setSelected((current) => current ?? value.drafts[0]?.id ?? null);
    return value;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!state || !selected) return;
    const draft = state.drafts.find((item) => item.id === selected) ?? null;
    setEditor(draft ? structuredClone(draft) : null);
    setDirty(false);
  }, [selected, state]);

  const selectedDraft = useMemo(
    () => state?.drafts.find((item) => item.id === selected) ?? null,
    [state, selected],
  );

  async function save() {
    if (!editor) return;
    setBusy(true);
    setStatus('Saving draft…');
    const response = await fetch(`/api/flags/${editor.id}`, {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        revision: editor.revision,
        content: editor.content,
        name: editor.name,
        state: editor.state,
        envs: editor.envs,
        dependsOn: editor.dependsOn,
      }),
    });
    setBusy(false);
    if (response.status === 409) {
      setStatus('Revision conflict — reload the latest draft');
      return;
    }
    if (!response.ok) {
      setStatus(`Save failed (${response.status})`);
      return;
    }
    const saved = (await response.json()) as Draft;
    setEditor(saved);
    setDirty(false);
    setStatus(`Saved revision ${saved.revision}`);
    void refresh();
  }

  function togglePick(id: string) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleEnv(env: string) {
    if (!editor) return;
    const envs = editor.envs.includes(env)
      ? editor.envs.filter((item) => item !== env)
      : [...editor.envs, env];
    setEditor({...editor, envs});
    setDirty(true);
  }

  function toggleDep(id: string) {
    if (!editor || id === editor.id) return;
    const dependsOn = editor.dependsOn.includes(id)
      ? editor.dependsOn.filter((item) => item !== id)
      : [...editor.dependsOn, id];
    setEditor({...editor, dependsOn});
    setDirty(true);
  }

  async function createFlag() {
    const id = newId.trim() || `flag-${Date.now().toString(36)}`;
    setNewId('');
    const response = await fetch('/api/flags', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({id, name: id}),
    });
    if (response.ok) {
      await refresh();
      setSelected(id);
    }
  }

  async function deleteFlag(id: string) {
    await fetch(`/api/flags/${id}`, {method: 'DELETE'});
    setPicked((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    await refresh();
  }

  async function publishSelected() {
    setBusy(true);
    setIssues([]);
    setConflicts([]);
    setConflictRelease(null);
    setStatus('Freezing drafts and validating…');
    const response = await fetch('/api/releases/publish', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        flagIds: [...picked],
        environment,
        note,
      }),
    });
    const body = await response.json();
    setBusy(false);
    if (response.status === 201) {
      setStatus(`Published ${body.release.id} — atomic switch complete`);
      setPicked(new Set());
      setNote('');
      setConflicts([]);
      setState(body.state);
      void evaluate(environment, body.state.activeReleaseId);
      return;
    }
    if (response.status === 409) {
      // The loser keeps its drafts; show the minimal conflict set and refresh.
      setConflicts(body.conflicts);
      setConflictRelease(body.currentActiveReleaseId);
      setState(body.state);
      setStatus(`发布冲突 — 另一页面已先发布 (${body.currentActiveReleaseId})，草稿已保留`);
      return;
    }
    if (response.status === 422) {
      setIssues(body.issues);
      setStatus(`验证失败：${body.issues.length} 个问题，全部 flag 均未生效`);
      return;
    }
    setStatus(`Publish failed (${response.status})`);
  }

  async function rollback(releaseId: string) {
    setBusy(true);
    setStatus(`Rolling back to ${releaseId}…`);
    const response = await fetch(`/api/releases/${releaseId}/rollback`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({}),
    });
    const body = await response.json();
    setBusy(false);
    if (response.status === 201) {
      setStatus(`Rolled back via new release ${body.release.id}`);
      setState(body.state);
      void evaluate(environment, body.state.activeReleaseId);
    }
  }

  async function evaluate(env?: string, expectRelease?: string) {
    const useEnv = env ?? environment;
    const response = await fetch('/api/evaluate', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({environment: useEnv}),
    });
    const body = await response.json();
    setEvaluation(body);
    if (expectRelease && body.releaseId !== expectRelease) {
      setStatus('观察到读取到非预期 release（切换窗口）');
    }
  }

  if (!state || !editor) {
    return (
      <main className="shell">
        <Header />
        <p className="loading">Loading workbench…</p>
      </main>
    );
  }

  return (
    <main className="shell">
      <Header />
      <section className="workspace release-workspace">
        <aside className="pane">
          <h2>Drafts</h2>
          <div className="new-flag">
            <input
              value={newId}
              placeholder="new flag id"
              onChange={(event) => setNewId(event.target.value)}
            />
            <button onClick={() => void createFlag()}>Add</button>
          </div>
          <div className="list">
            {state.drafts.map((item) => (
              <div key={item.id} className={`flag-row ${item.id === selected ? 'active' : ''}`}>
                <label className="pick">
                  <input
                    type="checkbox"
                    checked={picked.has(item.id)}
                    onChange={() => togglePick(item.id)}
                  />
                  <button className="flag-select" onClick={() => setSelected(item.id)}>
                    <strong>{item.name}</strong>
                    <small>
                      {item.id} · r{item.revision} · {item.state}
                    </small>
                  </button>
                </label>
                <button
                  className="icon-btn"
                  title="Delete draft (history stays)"
                  onClick={() => void deleteFlag(item.id)}
                >
                  <XCircle size={15} />
                </button>
              </div>
            ))}
          </div>

          <h2>Release</h2>
          <div className="release-box">
            <label className="field">
              目标环境
              <select value={environment} onChange={(event) => setEnvironment(event.target.value)}>
                {state.envs.map((env) => (
                  <option key={env} value={env}>
                    {env}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              发布说明
              <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="note" />
            </label>
            <p className="hint">
              发布集（{picked.size}）：{[...picked].join(', ') || '—'}
            </p>
            <button
              className="primary wide"
              disabled={busy || picked.size === 0}
              onClick={() => void publishSelected()}
            >
              <Send size={15} /> 原子发布所选草稿
            </button>
          </div>

          {issues.length > 0 && (
            <div className="panel error-panel">
              <h3>
                <XCircle size={15} /> 验证失败（全部不生效）
              </h3>
              <ul>
                {issues.map((issue, index) => (
                  <li key={index}>
                    <code>{JSON.stringify(issue)}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {conflicts.length > 0 && (
            <div className="panel warn-panel">
              <h3>
                <GitBranch size={15} /> 最小冲突集合
                {conflictRelease ? <> · 当前 release: {conflictRelease}</> : null}
              </h3>
              <ul>
                {conflicts.map((conflict, index) => (
                  <li key={index}>
                    <strong>{conflict.flagId}</strong>: {conflictLabel[conflict.kind]}
                    <code>{JSON.stringify(conflict)}</code>
                  </li>
                ))}
              </ul>
              <p className="hint">草稿未被改动；解决后保留勾选即可重新发布。</p>
            </div>
          )}
        </aside>

        <section className="pane">
          <div className="toolbar">
            <button className="primary" disabled={busy || !dirty} onClick={() => void save()}>
              <Save size={15} /> Save draft
            </button>
            <button onClick={() => void evaluate()}>
              <Play size={15} /> Evaluate
            </button>
            <span className={`status ${dirty ? 'dirty' : ''}`}>{status}</span>
          </div>

          <div className="meta-grid">
            <label className="field">
              名称
              <input
                value={editor.name}
                onChange={(event) => {
                  setEditor({...editor, name: event.target.value});
                  setDirty(true);
                }}
              />
            </label>
            <label className="field">
              状态
              <select
                value={editor.state}
                onChange={(event) => {
                  setEditor({...editor, state: event.target.value as Draft['state']});
                  setDirty(true);
                }}
              >
                <option value="active">active</option>
                <option value="disabled">disabled</option>
              </select>
            </label>
          </div>

          <div className="chips">
            <span className="chip-label">环境约束：</span>
            {state.envs.map((env) => (
              <button
                key={env}
                className={`chip ${editor.envs.includes(env) ? 'on' : ''}`}
                onClick={() => toggleEnv(env)}
              >
                {env}
              </button>
            ))}
          </div>

          <div className="chips deps">
            <span className="chip-label">依赖（闭包必须一起发布）：</span>
            {state.drafts
              .filter((item) => item.id !== editor.id)
              .map((item) => (
                <button
                  key={item.id}
                  className={`chip ${editor.dependsOn.includes(item.id) ? 'on' : ''}`}
                  onClick={() => toggleDep(item.id)}
                >
                  {item.id}
                </button>
              ))}
          </div>

          <textarea
            aria-label="Content"
            value={editor.content}
            onChange={(event) => {
              setEditor({...editor, content: event.target.value});
              setDirty(true);
            }}
          />
          {dirty && <p className="hint">未保存的修改（revision {editor.revision}）</p>}
        </section>

        <aside className="pane">
          <h2>
            <History size={15} /> Release 历史（append-only）
          </h2>
          <div className="releases">
            {[...state.releases].reverse().map((release) => (
              <div
                key={release.id}
                className={`release-card ${release.id === state.activeReleaseId ? 'active' : ''}`}
              >
                <div className="release-head">
                  <strong>
                    {release.id}
                    {release.id === state.activeReleaseId && (
                      <CheckCircle2 size={14} className="active-mark" />
                    )}
                  </strong>
                  <span className="kind">
                    {release.kind === 'rollback' ? (
                      <>
                        <RotateCcw size={12} /> rollback ← {release.rolledBackFrom}
                      </>
                    ) : (
                      'publish'
                    )}
                  </span>
                </div>
                <small>
                  {new Date(release.createdAt).toLocaleString()} · env: {release.environment} · parent:{' '}
                  {release.parentId ?? '—'}
                </small>
                <p>{release.note}</p>
                <div className="members">
                  {release.members.map((member) => (
                    <span key={member.id} className="member">
                      {member.id}@r{member.revision}
                    </span>
                  ))}
                </div>
                {release.id !== state.activeReleaseId && (
                  <button
                    className="wide"
                    disabled={busy}
                    onClick={() => void rollback(release.id)}
                  >
                    <RotateCcw size={13} /> 回滚到此（创建新 release）
                  </button>
                )}
              </div>
            ))}
          </div>

          <h2>
            <FlaskConical size={15} /> 评估视图
          </h2>
          {evaluation ? (
            <div className="eval">
              <p className="hint">
                release <strong>{evaluation.releaseId}</strong> · env {evaluation.environment}
                {selectedDraft ? '' : ''}
              </p>
              {evaluation.flags.map((flag) => (
                <div key={flag.id} className={`eval-row ${flag.on ? 'on' : 'off'}`}>
                  <span>{flag.on ? '🟢' : '⚪'}</span>
                  <strong>{flag.id}</strong>
                  <small>
                    r{flag.revision} · {flag.state}
                  </small>
                </div>
              ))}
              <p className="hint">单次评估只读一个不可变 release 快照，不会出现新旧混合。</p>
            </div>
          ) : (
            <p className="hint">点击 Evaluate 读取当前 active release。</p>
          )}
        </aside>
      </section>
    </main>
  );
}

function Header() {
  return (
    <header className="topbar">
      <FlaskConical size={20} />
      <strong>Feature Rules Workbench</strong>
      <small>原子发布 · 依赖闭包 · 可审计回滚</small>
    </header>
  );
}
