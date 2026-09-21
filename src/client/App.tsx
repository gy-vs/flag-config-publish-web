import {useCallback, useEffect, useState} from 'react';
import {FlaskConical, Play, Save, GitBranch, History, RotateCcw} from 'lucide-react';

type Summary = {id: string; name: string; revision: number; updatedAt: string; dependencies: string[]; environments: string[]};
type Row = Summary & {content: string};
type ReleaseSummary = {
  id: string;
  sequence: number;
  createdAt: string;
  createdBy: string;
  note: string;
  parentId: string | null;
  rollbackOf: string | null;
  flags: Record<string, {revision: number; name: string}>;
};

const jsonPost = async (url: string, body: unknown) => {
  const response = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  const payload = await response.json();
  return {ok: response.ok, status: response.status, payload};
};

export default function App() {
  const [items, setItems] = useState<Summary[]>([]);
  const [selected, setSelected] = useState('alpha');
  const [row, setRow] = useState<Row | null>(null);
  const [draft, setDraft] = useState('');
  const [dependencies, setDependencies] = useState('');
  const [environments, setEnvironments] = useState('');
  const [analysis, setAnalysis] = useState<unknown>(null);
  const [status, setStatus] = useState('Ready');
  const [releaseId, setReleaseId] = useState<string>('');
  const [releases, setReleases] = useState<ReleaseSummary[]>([]);
  const [feedback, setFeedback] = useState<{kind: 'ok' | 'error'; text: string} | null>(null);

  const refreshHistory = useCallback(async () => {
    const payload = await (await fetch('/api/releases')).json();
    setReleaseId(payload.currentReleaseId);
    setReleases(payload.releases);
  }, []);

  useEffect(() => {
    fetch('/api/flags').then(r => r.json()).then(setItems);
    refreshHistory();
  }, [refreshHistory]);

  useEffect(() => {
    setStatus('Loading');
    fetch('/api/flags/' + selected)
      .then(r => r.json())
      .then((value: Row) => {
        setRow(value);
        setDraft(value.content);
        setDependencies(value.dependencies.join(', '));
        setEnvironments(value.environments.join(', '));
        setAnalysis(null);
        setStatus('Loaded rev ' + value.revision);
      });
  }, [selected]);

  const splitList = (text: string): string[] =>
    text.split(',').map(value => value.trim()).filter(Boolean);

  async function save() {
    if (!row) return;
    setStatus('Saving');
    const response = await fetch('/api/flags/' + row.id, {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({content: draft, dependencies: splitList(dependencies), environments: splitList(environments), revision: row.revision}),
    });
    const value = await response.json();
    if (!response.ok) {
      setStatus('Revision conflict — reloading');
      setFeedback({kind: 'error', text: 'Draft changed elsewhere; reloaded the current revision.'});
      setRow(value.current ?? value);
      setDraft(value.current?.content ?? value.content);
      return;
    }
    setRow(value);
    setStatus('Saved rev ' + value.revision);
    setItems(current => current.map(item => (item.id === value.id ? value : item)));
  }

  async function analyze() {
    if (!row) return;
    setStatus('Analyzing');
    const {payload} = await jsonPost('/api/flags/' + row.id + '/analyze', {
      content: draft, dependencies: splitList(dependencies), environments: splitList(environments),
    });
    setAnalysis(payload);
    setStatus('Analyzed');
  }

  async function publishAll() {
    setStatus('Publishing release…');
    const {ok, payload} = await jsonPost('/api/releases/publish', {
      flags: items.map(item => ({id: item.id})),
      note: `workbench publish at ${new Date().toISOString()}`,
    });
    if (ok) {
      setFeedback({kind: 'ok', text: `Published ${payload.release.id} (${payload.currentReleaseId})`});
      setStatus('Published ' + payload.release.id);
      await refreshHistory();
    } else if (payload.error === 'validation_failed') {
      setFeedback({kind: 'error', text: `Validation failed — no flags took effect. ${payload.violations.length} violation(s).`});
      setAnalysis({validation: payload.violations});
      setStatus('Validation failed');
    } else {
      setFeedback({kind: 'error', text: `Publish conflict: ${JSON.stringify(payload.conflicts ?? payload.message)}`});
      setStatus('Conflict — drafts preserved');
    }
  }

  async function rollback(id: string) {
    const {ok, payload} = await jsonPost(`/api/releases/${id}/rollback`, {note: `workbench rollback to ${id}`});
    if (ok) {
      setFeedback({kind: 'ok', text: `Created ${payload.release.id} restoring content of ${id}`});
      await refreshHistory();
    } else {
      setFeedback({kind: 'error', text: `Rollback refused: ${payload.error}`});
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>Feature Evaluation Lab</strong>
        <small>current release: {releaseId}</small>
        <button className="topbar-action" onClick={publishAll}><GitBranch size={14} /> Publish all drafts as release</button>
      </header>
      <section className="workspace">
        <aside className="pane">
          <h2>Items</h2>
          <div className="list">
            {items.map(item => (
              <button className={item.id === selected ? 'active' : ''} onClick={() => setSelected(item.id)} key={item.id}>
                {item.name}
                <br /><small>Revision {item.revision} · {item.environments.join(', ')}</small>
              </button>
            ))}
          </div>
        </aside>
        <section className="pane">
          <div className="toolbar">
            <button className="primary" onClick={save}><Save size={15} />Save draft</button>
            <button onClick={analyze}><Play size={15} />Analyze</button>
            <span>{status}</span>
          </div>
          <label className="field-label">Rules</label>
          <textarea aria-label="Content" value={draft} onChange={event => setDraft(event.target.value)} />
          <label className="field-label">Dependencies (comma-separated flag ids)</label>
          <input className="field" value={dependencies} onChange={event => setDependencies(event.target.value)} />
          <label className="field-label">Environments</label>
          <input className="field" value={environments} onChange={event => setEnvironments(event.target.value)} />
          {feedback && <div className={feedback.kind === 'ok' ? 'feedback ok' : 'feedback error'}>{feedback.text}</div>}
        </section>
        <aside className="pane">
          <h2><History size={15} /> Release history</h2>
          <div className="releases">
            {releases.slice().reverse().map(release => (
              <div className={release.id === releaseId ? 'release current' : 'release'} key={release.id}>
                <div className="release-head">
                  <strong>{release.id}</strong>
                  {release.rollbackOf && <span className="pill">rollback of {release.rollbackOf}</span>}
                  {release.id === releaseId && <span className="pill live">live</span>}
                </div>
                <small>{release.note || '(no note)'} · {new Date(release.createdAt).toLocaleString()}</small>
                <div className="release-flags">
                  {Object.entries(release.flags).map(([id, meta]) => (
                    <span className="flag-chip" key={id}>{id}@r{meta.revision}</span>
                  ))}
                </div>
                {release.id !== releaseId && (
                  <button className="rollback" onClick={() => rollback(release.id)}>
                    <RotateCcw size={13} /> Restore as new release
                  </button>
                )}
              </div>
            ))}
          </div>
          <h2>Inspection</h2>
          <span className="pill">{selected}</span>
          <pre>{JSON.stringify(analysis ?? row, null, 2)}</pre>
        </aside>
      </section>
    </main>
  );
}
