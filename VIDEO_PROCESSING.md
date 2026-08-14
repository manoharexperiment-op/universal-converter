# Video processing

How the video side of MunnX Convertor is built, and the constraints that shaped
it. Written for whoever works on this next, including future me.

## The one constraint that explains everything

Video is processed by FFmpeg compiled to WebAssembly, running **single-threaded**
in the browser. That is deliberate: a multi-threaded build needs
`SharedArrayBuffer`, which needs COOP/COEP headers, which break the OCR worker.
Single-threaded keeps everything else working.

The cost is speed. Encoding runs at roughly **5 to 10 times real time**, so a
one-minute clip takes several minutes. Nearly every design decision below is
about not wasting that scarce throughput, or about not letting the user think
the app has hung.

## Layout

```
src/video/
  types.ts    typed operations, job model, error kinds
  probe.ts    reading a file's properties, timecode parsing
  graph.ts    operations  ->  one ffmpeg filter graph
  engine.ts   running a job, cancellation, cleanup
  merge.ts    joining several videos
  split.ts    cutting one video into parts
  fonts.ts    fonts for burned-in subtitles
  frames.ts   stills and thumbnails

src/converters/
  videoTools.ts     the registry's view: controls and adapters
  videoPipeline.ts  the steps offered by the multi-step editor
  batchQueue.ts     the observable processing queue
```

**Nothing outside `src/video/` builds an ffmpeg command.** The UI describes what
it wants as typed operations; the engine decides how to express that. This is
what makes the multi-step editor possible at all.

## The job model

```ts
interface VideoJob {
  input: File;
  ops: VideoOp[];       // applied in order
  output: VideoOutput;  // container, quality, bitrates
}
```

`VideoOp` is a discriminated union: `trim`, `crop`, `cropAspect`, `resize`,
`rotate`, `flip`, `speed`, `reverse`, `fps`, `volume`, `audioFade`,
`normalizeAudio`, `removeAudio`, `setAudio`, `subtitles`, `watermark`,
`textOverlay`.

## Why one graph instead of one pass per operation

`buildGraph()` folds every operation into a single filter chain, so a job runs
one decode and one encode however many edits it carries. Measured at **3.4x
faster** than running the same four edits sequentially, and the gap widens with
longer chains. It also avoids the generation loss of re-encoding at every step.

The graph builder tracks the frame size as filters change it, so an operation
that depends on the current dimensions (a percentage-sized watermark, a centre
crop) uses the real numbers rather than the source's.

## Things that look like they work but do not

These were all found by measuring output rather than trusting an exit code.
FFmpeg returning 0 means it ran, not that it did what you asked.

### Subtitles render nothing without a font

libass is compiled in, but the wasm filesystem ships **no fonts**. `subtitles`
produces a valid video, exits 0, and draws zero pixels. A font has to be written
into the filesystem first. `fonts.ts` looks at which scripts the subtitle text
actually contains and loads only those, because each font is a few hundred KB
that stays resident.

Bundled: Latin, Devanagari, Bengali, Tamil, Telugu, Arabic. CJK is deliberately
absent, one Chinese font is 8.1 MB against 1.5 MB for everything else combined.
Text in an unbundled script produces a warning rather than silent omission.

### Alignment is numbered the legacy SSA way

Not ASS v4+. `1-3` sit at the bottom, `5-7` at the top, `9-11` in the middle.
Reading it as v4+ puts "top" in the middle of the frame and "centre" at the top.
Established by rendering all eleven values and measuring where the text landed.

### Naive concat silently corrupts a mismatched merge

Listing files for the concat demuxer with `-c copy` exits 0 with the correct
total duration, which reads as success. But the container header keeps the first
clip's frame size while later frames carry their own, so players show the first
clip and then garbage. Every input is normalised first (scale, pad, setsar,
fps), and clips without audio get generated silence, because `concat` refuses to
run when its inputs disagree on stream count.

### `-t` after `-i` breaks trim combined with speed

As an output option it caps output duration rather than bounding how much source
is read. Alone that is harmless; with a speed change the sped-up stream is
shorter than the cap and ffmpeg holds the output open to the full trimmed
length. Trimming four seconds and doubling the speed gave four seconds instead
of two. Both seek flags now sit **before** `-i`.

### `-reset_timestamps` and `-avoid_negative_ts` fight each other

In fast split mode, adding `-avoid_negative_ts make_zero` overrides
`-reset_timestamps` in either order, and each part keeps its position on the
original timeline: part two of a 4s split reports itself as 8s and every player
draws a wrong scrubber.

### `drawtext` needs a font too

Which is why burned-in text is rendered to a PNG on a canvas and composited with
`overlay` instead. That uses the device's own fonts, so Devanagari and emoji
work, and nothing extra ships.

## Memory

A 32-bit wasm heap is the ceiling everything else is measured against.

- Input files are capped at **200 MB**.
- `reverse` buffers every decoded frame, so it is capped at **60 seconds** and
  refused up front, in milliseconds, with a suggestion to trim first.
- Batches run **one file at a time**. Decoding several videos at once is what
  actually exhausts the heap and kills the tab, and single-threaded there is no
  throughput to win by overlapping.
- Every job deletes its temporary files in a `finally`, including on failure.
- `ffmpeg.writeFile()` **transfers** its buffer. Writing the same `Uint8Array`
  twice throws `DataCloneError`; pass `.slice()`.

## Cancellation

FFmpeg has no interrupt. The only way to stop a running job is to terminate the
worker, which is what `terminateFFmpeg()` does; the pending `exec` rejects and
the next call reloads a fresh core. The batch queue distinguishes a user's skip
or cancel from a genuine failure so a deliberate stop is not reported as an
error.

## Errors

`describeFailure()` maps thrown values onto a small set of kinds
(`unsupported`, `corrupt`, `too-large`, `out-of-memory`, `invalid-range`,
`bad-subtitle`, `cancelled`) and produces a sentence a person can act on.
FFmpeg's own output is kept as `detail` and shown only behind a disclosure. An
exit code helps nobody.

## Adding an operation

1. Add a variant to `VideoOp` in `types.ts`.
2. Handle it in `buildGraph()` in `graph.ts`. Update the tracked `w`/`h` if it
   changes the frame. Escape commas inside filter arguments as `\\,`.
3. Add a `TargetOption` in `videoTools.ts` with its controls.
4. To make it available in the multi-step editor, add a `StepType` in
   `videoPipeline.ts`.
5. Verify by measuring the **output**: dimensions, duration, or pixels. Not the
   exit code. Every bug listed above returned zero.
