import { describe, it, expect } from 'vitest';
import { FIELD_TYPE_SPECS } from './field-specs.js';

describe('FIELD_TYPE_SPECS wire_shape advertisement', () => {
  it('advertises wire_shape for the field types where input ≠ output', () => {
    for (const t of ['references', 'asset', 'markdown', 'date', 'vector'] as const) {
      const spec = FIELD_TYPE_SPECS[t];
      expect(spec.wire_shape, `${t} must have wire_shape`).toBeDefined();
      expect(spec.wire_shape!.input).toBeTruthy();
      expect(spec.wire_shape!.input_example).toBeDefined();
      expect(spec.wire_shape!.output).toBeTruthy();
    }
  });

  it('omits wire_shape for trivial types where input === output', () => {
    for (const t of ['string', 'number', 'boolean', 'slug', 'enum', 'css', 'jss'] as const) {
      const spec = FIELD_TYPE_SPECS[t];
      expect(spec.wire_shape, `${t} should not bother with wire_shape`).toBeUndefined();
    }
  });

  it('references input shape is "type/slug" strings — never an array of objects', () => {
    const ws = FIELD_TYPE_SPECS.references.wire_shape!;
    expect(Array.isArray(ws.input_example)).toBe(true);
    for (const item of ws.input_example as unknown[]) {
      expect(typeof item).toBe('string');
      expect(item).toMatch(/^[a-z_][a-z0-9_]*\/[^@]+(@\d+)?$/);
    }
    // Resolved output is the projected entry envelope shape.
    const resolved = ws.output_example_resolved as Array<Record<string, unknown>>;
    expect(resolved[0]?.id).toBeDefined();
    expect(resolved[0]?.fields).toBeDefined();
  });

  it('asset input shape is the stable id (32 hex chars), output expands to {ref_key, url, …}', () => {
    const ws = FIELD_TYPE_SPECS.asset.wire_shape!;
    expect(ws.input_example).toMatch(/^[0-9a-f]{32}$/);
    const resolved = ws.output_example_resolved as Record<string, unknown>;
    expect(resolved.id).toBeDefined();
    expect(resolved.ref_key).toBeDefined();
    expect(resolved.url).toBeDefined();
  });

  it('date wire_shape flags the YYYY-MM-DD-vs-Date trap', () => {
    const ws = FIELD_TYPE_SPECS.date.wire_shape!;
    expect(ws.input_example).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(ws.notes).toBeDefined();
    expect(ws.notes).toMatch(/timezone|UTC|previous day/i);
  });

  it('markdown wire_shape mentions the :::ref{}::: directive + resolve_refs sidecar', () => {
    const ws = FIELD_TYPE_SPECS.markdown.wire_shape!;
    expect(ws.input_example).toContain(':::ref{');
    expect(ws.notes).toMatch(/resolve_refs/);
    expect(ws.notes).toMatch(/_refs/);
  });

  it('vector input is an array of numbers with length matching dims', () => {
    const ws = FIELD_TYPE_SPECS.vector.wire_shape!;
    expect(ws.input).toMatch(/dims/);
    expect(ws.input).toMatch(/number/);
  });
});
