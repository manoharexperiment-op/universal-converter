import { useState } from 'react';
import { CATEGORIES, convert, defaultPair, formatResult, getCategory, getUnit, unitName } from './unitData';

function parseValue(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

export function UnitConverter(): JSX.Element {
  const [categoryId, setCategoryId] = useState<string>(CATEGORIES[0].id);
  const [pair, setPair] = useState<[string, string]>(() => defaultPair(CATEGORIES[0].id));
  const [raw, setRaw] = useState('1');

  const category = getCategory(categoryId) ?? CATEGORIES[0];
  const [fromId, toId] = pair;
  const fromUnit = getUnit(category.id, fromId);
  const toUnit = getUnit(category.id, toId);

  const value = parseValue(raw);
  const converted = value === null ? NaN : convert(category.id, fromId, toId, value);
  const result = formatResult(converted);

  // Temperature scales are affine, so "1 °C = 33.8 °F" invites the wrong mental
  // model. Anchoring that line at zero states a fact nobody can misuse.
  const anchor = category.id === 'temperature' ? 0 : 1;
  const anchorOut = formatResult(convert(category.id, fromId, toId, anchor));

  const pickCategory = (id: string) => {
    setCategoryId(id);
    setPair(defaultPair(id));
  };

  return (
    <div className="uc-wrap">
      <div className="uc-cats" role="tablist" aria-label="Unit category">
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={c.id === category.id}
            className={c.id === category.id ? 'uc-cat is-active' : 'uc-cat'}
            onClick={() => pickCategory(c.id)}
          >
            <span className="uc-cat-icon" aria-hidden="true">{c.icon}</span>
            <span className="uc-cat-label">{c.label}</span>
          </button>
        ))}
      </div>

      <div className="uc-row">
        <input
          className="uc-input"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={raw}
          aria-label="Value to convert"
          placeholder="Enter a value"
          onChange={(e) => setRaw(e.target.value)}
        />
        <select
          className="uc-select"
          value={fromId}
          aria-label="Convert from"
          onChange={(e) => setPair([e.target.value, toId])}
        >
          {category.units.map((u) => (
            <option key={u.id} value={u.id}>{u.label}</option>
          ))}
        </select>
      </div>

      <button type="button" className="uc-swap" aria-label="Swap units" title="Swap units" onClick={() => setPair([toId, fromId])}>
        <span aria-hidden="true">⇅</span>
      </button>

      <div className="uc-row">
        <div className="uc-result" aria-live="polite">
          <span className="uc-result-value">{result}</span>
          {result ? <span className="uc-result-unit"> {unitName(toUnit)}</span> : null}
        </div>
        <select
          className="uc-select"
          value={toId}
          aria-label="Convert to"
          onChange={(e) => setPair([fromId, e.target.value])}
        >
          {category.units.map((u) => (
            <option key={u.id} value={u.id}>{u.label}</option>
          ))}
        </select>
      </div>

      {anchorOut ? (
        <p className="uc-equation">
          {anchor} {unitName(fromUnit)} = {anchorOut} {unitName(toUnit)}
        </p>
      ) : null}
    </div>
  );
}
