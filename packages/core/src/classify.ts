import type { FieldDef, TypeDef } from '@ledric/schema';
import type { ChangeClass } from '@ledric/storage';

export interface FieldDiff {
  path: string;
  kind: 'added' | 'removed' | 'type_changed' | 'required_added' | 'constraint_widened' | 'constraint_narrowed' | 'options_changed';
  before?: unknown;
  after?: unknown;
}

export interface TypeDiff {
  class: ChangeClass;
  fields: FieldDiff[];
  options: FieldDiff[];
}

export function classifyChange(oldDef: TypeDef, newDef: TypeDef): TypeDiff {
  const fieldDiffs: FieldDiff[] = [];
  const optionDiffs: FieldDiff[] = [];

  let destructive = false;
  let needsBackfill = false;

  const oldNames = Object.keys(oldDef.fields);
  const newNames = Object.keys(newDef.fields);

  for (const name of oldNames) {
    if (!(name in newDef.fields)) {
      fieldDiffs.push({ path: `/fields/${name}`, kind: 'removed', before: oldDef.fields[name] });
      destructive = true;
      continue;
    }
    const before = oldDef.fields[name];
    const after = newDef.fields[name];
    if (before && after) {
      const fd = diffField(`/fields/${name}`, before, after);
      for (const d of fd) {
        fieldDiffs.push(d);
        if (d.kind === 'type_changed') destructive = true;
        if (d.kind === 'required_added') needsBackfill = true;
        if (d.kind === 'constraint_narrowed') needsBackfill = true;
      }
    }
  }

  for (const name of newNames) {
    if (!(name in oldDef.fields)) {
      const after = newDef.fields[name];
      fieldDiffs.push({ path: `/fields/${name}`, kind: 'added', after });
      if (after && after.required === true) needsBackfill = true;
    }
  }

  const OPTION_KEYS: Array<keyof TypeDef> = [
    'description',
    'identifier_field',
    'display_field',
    'summary_fields',
    'on_slug_change',
    'example'
  ];
  for (const k of OPTION_KEYS) {
    const before = oldDef[k as keyof TypeDef];
    const after = newDef[k as keyof TypeDef];
    if (!deepEqual(before, after)) {
      optionDiffs.push({ path: `/${String(k)}`, kind: 'options_changed', before, after });
    }
  }

  const cls: ChangeClass = destructive ? 'destructive' : needsBackfill ? 'needs_backfill' : 'safe';

  return { class: cls, fields: fieldDiffs, options: optionDiffs };
}

function diffField(path: string, before: FieldDef, after: FieldDef): FieldDiff[] {
  if (before.type !== after.type) {
    return [{ path, kind: 'type_changed', before, after }];
  }
  const out: FieldDiff[] = [];

  if (before.required !== true && after.required === true) {
    out.push({ path: `${path}/required`, kind: 'required_added' });
  }

  const maxBefore = (before as { max?: number }).max;
  const maxAfter = (after as { max?: number }).max;
  if (typeof maxBefore === 'number' && typeof maxAfter === 'number' && maxAfter !== maxBefore) {
    out.push({
      path: `${path}/max`,
      kind: maxAfter < maxBefore ? 'constraint_narrowed' : 'constraint_widened',
      before: maxBefore,
      after: maxAfter
    });
  } else if (maxBefore === undefined && typeof maxAfter === 'number') {
    out.push({ path: `${path}/max`, kind: 'constraint_narrowed', after: maxAfter });
  }

  const minBefore = (before as { min?: number }).min;
  const minAfter = (after as { min?: number }).min;
  if (typeof minBefore === 'number' && typeof minAfter === 'number' && minAfter !== minBefore) {
    out.push({
      path: `${path}/min`,
      kind: minAfter > minBefore ? 'constraint_narrowed' : 'constraint_widened',
      before: minBefore,
      after: minAfter
    });
  } else if (minBefore === undefined && typeof minAfter === 'number') {
    out.push({ path: `${path}/min`, kind: 'constraint_narrowed', after: minAfter });
  }

  if (!deepEqual((before as { description?: string }).description, (after as { description?: string }).description)) {
    out.push({
      path: `${path}/description`,
      kind: 'options_changed',
      before: (before as { description?: string }).description,
      after: (after as { description?: string }).description
    });
  }

  return out;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
