import { useState } from 'react';
import type { ParamControl, ParamValue, ParamValues } from './converters/types';
import type { Pipeline, PipeStep } from './converters/videoPipeline';
import { newStep, STEP_TYPES, stepType } from './converters/videoPipeline';

/**
 * Build a chain of edits for one video.
 *
 * The order shown is the order applied, and the whole chain runs as a single
 * pass, so there is no downloading and re-uploading between steps and no
 * quality lost to repeated re-encoding.
 */
export function PipelineEditor({
  value,
  onChange,
  renderControls,
}: {
  value: Pipeline;
  onChange: (p: Pipeline) => void;
  /** Supplied by the app so steps reuse exactly the same controls as elsewhere. */
  renderControls: (
    params: ParamControl[],
    values: ParamValues,
    onParamChange: (key: string, v: ParamValue) => void,
  ) => JSX.Element;
}) {
  const [adding, setAdding] = useState('');
  const steps = value.steps;

  const update = (next: PipeStep[]) => onChange({ steps: next });

  const add = (kind: string) => {
    if (!kind) return;
    update([...steps, newStep(kind)]);
    setAdding('');
  };
  const remove = (id: string) => update(steps.filter((s) => s.id !== id));
  const move = (i: number, to: number) => {
    if (to < 0 || to >= steps.length) return;
    const next = [...steps];
    const [it] = next.splice(i, 1);
    next.splice(to, 0, it);
    update(next);
  };
  const setValue = (id: string, key: string, v: ParamValue) =>
    update(steps.map((s) => (s.id === id ? { ...s, values: { ...s.values, [key]: v } } : s)));

  return (
    <div className="pipe">
      {steps.length === 0 && (
        <p className="pipe-empty">
          Add the steps you want, in the order you want them. They all run in one pass, so nothing is
          re-encoded between them.
        </p>
      )}

      <ol className="pipe-list">
        {steps.map((step, i) => {
          const t = stepType(step.kind);
          if (!t) return null;
          return (
            <li className="pipe-step" key={step.id}>
              <div className="pipe-head">
                <span className="pipe-num">{i + 1}</span>
                <span className="pipe-label">{t.label}</span>
                <span className="pipe-summary">{safeSummary(t.summary, step.values)}</span>
                <span className="pipe-actions">
                  <button type="button" onClick={() => move(i, i - 1)} disabled={i === 0} title="Move up">↑</button>
                  <button type="button" onClick={() => move(i, i + 1)} disabled={i === steps.length - 1} title="Move down">↓</button>
                  <button type="button" className="pipe-del" onClick={() => remove(step.id)} title="Remove this step">✕</button>
                </span>
              </div>
              {t.controls.length > 0 && (
                <div className="pipe-body">
                  {renderControls(t.controls, step.values, (key, v) => setValue(step.id, key, v))}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      <div className="pipe-add">
        <select value={adding} onChange={(e) => add(e.target.value)}>
          <option value="">＋ Add a step…</option>
          {STEP_TYPES.map((t) => (
            <option key={t.kind} value={t.kind}>{t.label}</option>
          ))}
        </select>
        {steps.length > 1 && (
          <span className="pipe-count">{steps.length} steps, one pass</span>
        )}
      </div>
    </div>
  );
}

/** A step can be half-filled while being edited, so a summary must not throw. */
function safeSummary(fn: (v: ParamValues) => string, values: ParamValues): string {
  try {
    return fn(values);
  } catch {
    return '';
  }
}
