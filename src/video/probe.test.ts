import { describe, expect, it } from 'vitest';
import { formatTimecode, parseProbe, parseTimecode } from './probe';

describe('parseTimecode', () => {
  it('reads plain seconds', () => {
    expect(parseTimecode('90')).toBe(90);
    expect(parseTimecode('5.5')).toBe(5.5);
    expect(parseTimecode(42)).toBe(42);
  });

  it('reads MM:SS and HH:MM:SS', () => {
    expect(parseTimecode('1:30')).toBe(90);
    expect(parseTimecode('01:30')).toBe(90);
    expect(parseTimecode('0:01:30')).toBe(90);
    expect(parseTimecode('1:02:03')).toBe(3723);
    expect(parseTimecode('00:00:05.5')).toBe(5.5);
  });

  it('rejects anything it cannot read, rather than guessing', () => {
    expect(parseTimecode('')).toBeNull();
    expect(parseTimecode('abc')).toBeNull();
    expect(parseTimecode('1:xx')).toBeNull();
    expect(parseTimecode('1:2:3:4')).toBeNull();
    expect(parseTimecode('-5')).toBeNull();
  });
});

describe('formatTimecode', () => {
  it('drops the hour when there is not one', () => {
    expect(formatTimecode(90)).toBe('1:30');
    expect(formatTimecode(5)).toBe('0:05');
    expect(formatTimecode(3723)).toBe('1:02:03');
  });

  it('does not produce nonsense for bad input', () => {
    expect(formatTimecode(-1)).toBe('0:00');
    expect(formatTimecode(NaN)).toBe('0:00');
  });
});

describe('parseProbe', () => {
  const sample = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'in.mp4':
  Duration: 00:01:23.45, start: 0.000000, bitrate: 2543 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 2405 kb/s, 29.97 fps, 30 tbr, 90k tbn
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s`;

  it('reads every field off ffmpeg output', () => {
    const info = parseProbe(sample, 'in.mp4', 12345);
    expect(info.durationSeconds).toBeCloseTo(83.45, 2);
    expect(info.width).toBe(1920);
    expect(info.height).toBe(1080);
    expect(info.fps).toBe(29.97);
    expect(info.videoCodec).toBe('h264');
    expect(info.audioCodec).toBe('aac');
    expect(info.hasAudio).toBe(true);
    expect(info.bitrateKbps).toBe(2543);
    expect(info.format).toBe('mov');
  });

  it('is not fooled by the SAR and DAR ratios on the same line', () => {
    // "1:1" and "16:9" sit right beside the real 1920x1080.
    const info = parseProbe(sample, 'in.mp4', 0);
    expect(info.width).toBe(1920);
    expect(info.height).toBe(1080);
  });

  it('reports a silent video as having no audio', () => {
    const silent = sample.split('\n').filter((l) => !/Audio:/.test(l)).join('\n');
    const info = parseProbe(silent, 'in.mp4', 0);
    expect(info.hasAudio).toBe(false);
    expect(info.audioCodec).toBeNull();
  });

  it('returns zeroes rather than throwing on output it cannot parse', () => {
    const info = parseProbe('no such file', 'x.mp4', 0);
    expect(info.width).toBe(0);
    expect(info.durationSeconds).toBe(0);
  });
});
