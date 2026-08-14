import { describe, expect, it } from 'vitest';
import { describePages, parsePageRanges } from './pageRanges';

describe('parsePageRanges', () => {
  it('reads single pages and returns 0-based indices', () => {
    expect(parsePageRanges('2', 10)).toEqual([1]);
    expect(parsePageRanges('1,3,5', 10)).toEqual([0, 2, 4]);
  });

  it('reads ranges, and sorts regardless of the order given', () => {
    expect(parsePageRanges('2,5-7', 10)).toEqual([1, 4, 5, 6]);
    expect(parsePageRanges('5-7, 2', 10)).toEqual([1, 4, 5, 6]);
  });

  it('accepts a range written backwards', () => {
    expect(parsePageRanges('7-5', 10)).toEqual([4, 5, 6]);
  });

  it('treats an open end as "to the end", and an open start as "from page one"', () => {
    expect(parsePageRanges('3-', 6)).toEqual([2, 3, 4, 5]);
    expect(parsePageRanges('-3', 6)).toEqual([0, 1, 2]);
  });

  it('de-duplicates overlapping input', () => {
    expect(parsePageRanges('1,1,1', 5)).toEqual([0]);
    expect(parsePageRanges('1-3,2-4', 5)).toEqual([0, 1, 2, 3]);
  });

  it('ignores pages the document does not have rather than rejecting the line', () => {
    expect(parsePageRanges('99', 5)).toEqual([]);
    expect(parsePageRanges('2,99', 5)).toEqual([1]);
    expect(parsePageRanges('0', 5)).toEqual([]);
  });

  it('returns nothing for input it cannot read', () => {
    expect(parsePageRanges('', 5)).toEqual([]);
    expect(parsePageRanges('abc', 5)).toEqual([]);
  });

  it('accepts spaces and en dashes, since people paste both', () => {
    expect(parsePageRanges('2 5 7', 10)).toEqual([1, 4, 6]);
    expect(parsePageRanges('2–4', 10)).toEqual([1, 2, 3]);
  });
});

describe('describePages', () => {
  it('collapses consecutive pages into runs', () => {
    expect(describePages([0, 1, 2, 6])).toBe('1-3, 7');
    expect(describePages([3])).toBe('4');
    expect(describePages([])).toBe('none');
  });
});
