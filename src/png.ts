import { createHash } from "node:crypto";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

// Pictures compared as people see them: two are the same when the bytes are, or
// when no more than `ratio` of their pixels differ by more than `pixel` (pixelmatch's
// per-pixel threshold, anti-aliasing ignored). Pictures of different sizes differ.

export type Threshold = Readonly<{ pixel: number; ratio: number }>;

export const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export type Compared = Readonly<{
  changed: boolean;
  /** Pixels that differ, of all of them. */
  ratio: number;
  /** The after picture faded, its changes in red: none when unchanged or resized. */
  diff: Buffer | null;
}>;

export function compare(before: Buffer, after: Buffer, threshold: Threshold): Compared {
  if (before.equals(after)) return { changed: false, diff: null, ratio: 0 };
  const a = PNG.sync.read(before);
  const b = PNG.sync.read(after);
  if (a.width !== b.width || a.height !== b.height) return { changed: true, diff: null, ratio: 1 };
  const diff = new PNG({ height: a.height, width: a.width });
  const pixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, {
    alpha: 0.2,
    diffColor: [220, 38, 38],
    threshold: threshold.pixel,
  });
  const ratio = pixels / (a.width * a.height);
  return { changed: ratio > threshold.ratio, diff: PNG.sync.write(diff), ratio };
}

/** Before and after, side by side on white, top-aligned: one picture for a pull request. */
export function pair(before: Buffer, after: Buffer, gap = 24): Buffer {
  const a = PNG.sync.read(before);
  const b = PNG.sync.read(after);
  const out = new PNG({ height: Math.max(a.height, b.height), width: a.width + gap + b.width });
  out.data.fill(255);
  PNG.bitblt(a, out, 0, 0, a.width, a.height, 0, 0);
  PNG.bitblt(b, out, 0, 0, b.width, b.height, a.width + gap, 0);
  return PNG.sync.write(out);
}

/** A PNG's width and height, from its header. */
export function size(bytes: Buffer): { height: number; width: number } | null {
  if (bytes.length < 24 || bytes.subarray(1, 4).toString() !== "PNG") return null;
  return { height: bytes.readUInt32BE(20), width: bytes.readUInt32BE(16) };
}
