import { describe, it, expect } from 'vitest';
import {
  wrapInValue,
  linePrefixInValue,
  insertAt,
  assetSnippet
} from './markdown-edit.js';

describe('wrapInValue', () => {
  it('wraps a non-empty selection with the given markers', () => {
    const r = wrapInValue('hello world', 0, 5, '**');
    expect(r.value).toBe('**hello** world');
    expect(r.selectionStart).toBe(2);
    expect(r.selectionEnd).toBe(7);
  });

  it('supports asymmetric markers (e.g. link syntax)', () => {
    const r = wrapInValue('text', 0, 4, '[', '](url)');
    expect(r.value).toBe('[text](url)');
  });

  it('puts the caret between markers when nothing is selected', () => {
    const r = wrapInValue('abc', 1, 1, '**');
    expect(r.value).toBe('a****bc');
    expect(r.selectionStart).toBe(3);
    expect(r.selectionEnd).toBe(3);
  });
});

describe('linePrefixInValue', () => {
  it('prefixes the line containing a single-point selection', () => {
    const r = linePrefixInValue('one\ntwo\nthree', 5, 5, '## ');
    expect(r.value).toBe('one\n## two\nthree');
    expect(r.selectionStart).toBe(7);
    expect(r.selectionEnd).toBe(10);
  });

  it('prefixes every selected line', () => {
    const v = 'one\ntwo\nthree';
    // selection covers "two\nthr"
    const r = linePrefixInValue(v, 4, 11, '> ');
    expect(r.value).toBe('one\n> two\n> three');
  });

  it('handles selections in the first line', () => {
    const r = linePrefixInValue('alpha', 0, 3, '- ');
    expect(r.value).toBe('- alpha');
  });
});

describe('insertAt', () => {
  it('splices text at a position', () => {
    const r = insertAt('abcdef', 3, 'XYZ');
    expect(r.value).toBe('abcXYZdef');
    expect(r.selectionStart).toBe(6);
    expect(r.selectionEnd).toBe(6);
  });
});

describe('assetSnippet', () => {
  it('produces a markdown image for image assets', () => {
    expect(assetSnippet('image', 'hero.png', '/assets/abc')).toBe(
      '![hero.png](/assets/abc)'
    );
  });

  it('falls back to a plain link for non-image assets', () => {
    expect(assetSnippet('file', 'doc.pdf', '/assets/abc')).toBe(
      '[doc.pdf](/assets/abc)'
    );
  });

  it('uses the URL as label when label is empty', () => {
    expect(assetSnippet('file', '', '/assets/abc')).toBe(
      '[/assets/abc](/assets/abc)'
    );
  });

  it('strips brackets from labels to avoid breaking the snippet', () => {
    expect(assetSnippet('image', 'foo[bar].png', '/assets/abc')).toBe(
      '![foobar.png](/assets/abc)'
    );
  });
});
