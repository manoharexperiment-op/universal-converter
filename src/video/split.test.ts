import { describe, expect, it } from 'vitest';
import { cutPoints, segmentsFor } from './split';

describe('cutPoints', () => {
  it('spaces cuts evenly for a fixed chunk length', () => {
    expect(cutPoints({ kind: 'every', seconds: 3 }, 10)).toEqual([3, 6, 9]);
  });

  it('sorts, de-duplicates and drops timestamps outside the video', () => {
    expect(cutPoints({ kind: 'at', times: [2, 5, 8, 99, -1, 5] }, 10)).toEqual([2, 5, 8]);
  });

  it('refuses a chunk length of zero', () => {
    expect(() => cutPoints({ kind: 'every', seconds: 0 }, 10)).toThrow(/more than zero/i);
  });

  it('refuses a chunk longer than the video, which would produce one part', () => {
    expect(() => cutPoints({ kind: 'every', seconds: 20 }, 10)).toThrow(/only 10s/i);
  });

  it('refuses when no timestamp falls inside the video', () => {
    expect(() => cutPoints({ kind: 'at', times: [50, 60] }, 10)).toThrow(/inside the video/i);
  });
});

describe('segmentsFor', () => {
  it('covers the whole video, start to finish, with no gaps', () => {
    const segs = segmentsFor([3, 6, 9], 10);
    expect(segs).toEqual([
      { start: 0, end: 3 },
      { start: 3, end: 6 },
      { start: 6, end: 9 },
      { start: 9, end: 10 },
    ]);
    expect(segs[0].start).toBe(0);
    expect(segs[segs.length - 1].end).toBe(10);
  });

  it('drops a trailing sliver too short to be a real part', () => {
    // A cut at 9.99 on a 10s video would otherwise leave a 10ms segment.
    expect(segmentsFor([9.99], 10)).toEqual([{ start: 0, end: 9.99 }]);
  });
});
