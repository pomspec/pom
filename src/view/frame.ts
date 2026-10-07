import type { Video } from "./model.ts";

// A video's frame at a moment: the clean recording (the app alone) and, over it, what the
// journey did, drawn as a well-produced product video draws it. One module for every
// renderer: pomspec's video page draws it live over the recording (`pomspec/frame`), and
// the videos runner (prototype/videos.ts) draws it over each frame of the recording in
// Chromium to make the MP4 and GIF a pull request shows, so the two can never drift.
//
// - The camera glides in on where each step happens (about 1.5x, never past 1.8x, the
//   target and its surroundings in view), holds while the pointer types there, and
//   eases back out to the whole screen when nothing happens for a while, or on the way
//   to somewhere far. It sets off as a step starts, so it is there when the step acts,
//   and it never shows outside the video. One move at a time: a glide is never cut
//   short by the next.
// - A spotlight on what each "I see" proves: everything else dimmed, a soft cutout
//   around it, lit once the camera is there and held long enough to read; a control
//   that is missing gets it on the closest, edged in red.
// - Captions as a video site draws automatic ones: at most two rows at the bottom, each
//   line's words appearing one by one where they will stay, the rows rolling up as a new
//   one starts.
// - A larger, smoothed pointer, and a quick pulse where it clicks.
//
// Everything is a pure function of the video (video.json) and a time, in its own pixels
// and seconds: the same video always makes the same frames. A classic script, no imports
// at run time (the videos runner injects it with Node's type stripping): it sets
// `window.PomFrame`.

type Box = Readonly<{ h: number; w: number; x: number; y: number }>;

/** What the drawing reads of a video: its marks. */
export type Scene = Pick<
  Video,
  "badges" | "checks" | "duration" | "lines" | "pointer" | "rings" | "ripples" | "size"
>;

/** Where the camera looks: the centre of its view and how far in, in the video's pixels. */
export type View = { x: number; y: number; zoom: number };

/** What a spotlight shows: a box lit, the rest dimmed by `opacity` of the full dimming. */
export type Spot = {
  box: Box;
  label: string | null;
  labelAt: Readonly<{ x: number; y: number }> | null;
  opacity: number;
  tone: "found" | "missing";
};

/** The captions at a moment: the rows shown (two, a third rolling out) and how far they rolled. */
export type Captions = {
  font: number;
  /** 1, or less while what the step is about is under them: it shows through. */
  opacity: number;
  /** Each row's words: all of them (where they will stand), and those shown so far. */
  rows: Array<{ shown: string; text: string }>;
  /** 0 as a new row starts below, 1 once the rows have rolled up to make room for it. */
  roll: number;
};

export type DrawOptions = { captions?: boolean; lift?: number };

export type PomFrame = {
  /** Puts `media` (the video, or a frame's picture) in a camera inside `stage`, with the layers. */
  build(stage: HTMLElement, media: HTMLElement): void;
  camera(video: Scene, t: number): View;
  captions(video: Scene, t: number): Captions | null;
  /** Draws the frame at `t` into a stage `build` made: the camera's transform, the marks, the captions. */
  draw(stage: HTMLElement, video: Scene, t: number, options?: DrawOptions): void;
  /** Where the pointer is, how far into a click's press (0 none, 1 fully pressed), and whether it shows. */
  pointer(video: Scene, t: number): { opacity: number; press: number; x: number; y: number };
  spotlight(video: Scene, t: number): Spot | null;
  /** The moment that stands for the video: its first proof (else where it stopped) lit, the camera still, its caption written. */
  still(video: Scene): number;
};

declare global {
  interface Window {
    PomFrame: PomFrame;
  }
}

(() => {
  /** A camera glide, in, out or along. */
  const GLIDE = 0.6;
  /** A glide to somewhere far: out to the whole screen and in again, in one move. */
  const SWOOP = 0.9;
  /** Nothing happening this long: the camera eases back out. */
  const IDLE = 1.2;
  /** The least time spent at the whole screen when easing out between two steps; less is a bounce. */
  const REST = 0.4;
  const ZOOM = 1.5;
  const MAX_ZOOM = 1.8;
  /** Below this, a zoom is not worth the motion: the camera stays out. */
  const MIN_ZOOM = 1.2;
  /** The surroundings kept in view around a target, as a share of the video's width. */
  const ROOM = 0.04;
  /** The most of the view's area a target may fill: the rest is its surroundings, dimmed. */
  const FILL = 0.4;
  /** Where a target sits in the view: a little above the middle, away from the captions. */
  const ABOVE = 0.08;
  /** Two views sharing less than this of themselves are a far jump: out, then in. */
  const NEAR = 0.3;
  /** How long typing (a step that checks and finds nothing, after a click) keeps the camera in. */
  const TYPING = 3;
  /** How long the camera stays on a click once it is made: its pulse. */
  const AFTER_CLICK = 0.35;
  /** A spotlight's fade, in and out. */
  const FADE = 0.2;
  /** The least a spotlight is on, fades included: long enough to read what it lights. */
  const LIT = 1.2;
  const DIM = 0.45;
  /** The room a spotlight leaves around what it proves. */
  const AROUND = 10;
  /** The rows' roll as a new one starts. */
  const ROLL = 0.15;
  /** The share of a line's time its words take to appear, and the slowest a word comes. */
  const PACE = 0.8;
  const WORD = 0.32;
  /** How long the captions stay after their line, when no other follows. */
  const LINGER = 1;
  const PRESS = 0.22;
  const PULSE = 0.4;
  const POP = 0.14;
  const BLUE = "#1b45d1";
  const DEEP = "#102c8a";
  const RED = "#dc2626";
  /** The quiet rings, as they always were: what a step was found by, and where the reference had it. */
  const QUIET: Record<string, string> = { by: "#94a3b8", was: "#2563eb" };
  const ARROW = "polygon(0 0,0 84%,24% 66%,43% 100%,60% 92%,42% 59%,78% 59%)";
  const FONT = "font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";

  const unit = (v: number) => Math.min(1, Math.max(0, v));
  const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const easeOut = (p: number) => 1 - Math.pow(1 - p, 3);
  const escape = (text: string) =>
    String(text).replace(
      /[&<>"]/g,
      (c) => ({ '"': "&quot;", "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c,
    );
  /** A mark's end: one still open (-1) lasts a second. */
  const endOf = (mark: { end: number; start: number }) =>
    mark.end > mark.start ? mark.end : mark.start + 1;
  const union = (a: Box, b: Box): Box => {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return {
      h: Math.max(a.y + a.h, b.y + b.h) - y,
      w: Math.max(a.x + a.w, b.x + b.w) - x,
      x,
      y,
    };
  };

  /** Results computed once per video, kept while the video is. */
  function cached<T>(make: (video: Scene) => T) {
    const memo = new WeakMap<Scene, T>();
    return (video: Scene) => {
      let value = memo.get(video);
      if (value === undefined) memo.set(video, (value = make(video)));
      return value;
    };
  }

  const linesOf = cached((video: Scene) => [...video.lines].sort((a, b) => a.start - b.start));

  // The pointer -------------------------------------------------------------------

  /**
   * The pointer comes in with its first move (from a little below and right of where it
   * goes), and glides from there.
   */
  function pointer(video: Scene, t: number) {
    const first = video.pointer[0];
    if (!first || t < first.start) return { opacity: 0, press: 0, x: 0, y: 0 };
    let x = Math.min(video.size.width - 8, first.x + 90);
    let y = Math.min(video.size.height - 8, first.y + 110);
    for (const move of video.pointer) {
      if (t < move.start) break;
      const p = easeInOut(unit((t - move.start) / Math.max(0.001, move.end - move.start)));
      x += (move.x - x) * p;
      y += (move.y - y) * p;
    }
    let press = 0;
    for (const click of video.ripples) {
      const p = (t - click.at) / PRESS;
      if (p >= 0 && p < 1) press = Math.sin(Math.PI * p);
    }
    return { opacity: unit((t - first.start) / POP), press, x, y };
  }

  // The camera --------------------------------------------------------------------

  type Ring = Scene["rings"][number];
  /** Something the camera goes to: a control acted on or proven, or the screen as a whole. */
  type Shot = {
    /** When it happens: the ring's start, or the screen check's. */
    at: number;
    /** The step's start: the camera may set off for it then. */
    begin: number;
    box: Box | null;
    /** When it clicks there, if it does. */
    click: number | null;
    ring: Ring | null;
  };
  type Move = { end: number; from: View; start: number; swoop: boolean; to: View };
  /** What a step is about, while it is: where it is on the screen once the camera is there. */
  type Subject = { box: Box; end: number; start: number; view: View };
  type Plan = {
    lit: Map<Ring, { end: number; start: number }>;
    moves: Array<Move>;
    subjects: Array<Subject>;
  };

  const whole = (video: Scene): View => ({
    x: video.size.width / 2,
    y: video.size.height / 2,
    zoom: 1,
  });

  /** A view kept inside the video. */
  function inside(video: Scene, view: View): View {
    const { height, width } = video.size;
    const zoom = Math.min(MAX_ZOOM, Math.max(1, view.zoom));
    const halfW = width / zoom / 2;
    const halfH = height / zoom / 2;
    return {
      x: Math.min(width - halfW, Math.max(halfW, view.x)),
      y: Math.min(height - halfH, Math.max(halfH, view.y)),
      zoom,
    };
  }

  /** The view on a target: in as far as keeps it and its surroundings, a little above the middle. */
  function viewOn(video: Scene, box: Box): View {
    const { height, width } = video.size;
    const room = width * ROOM;
    const zoom = Math.min(
      ZOOM,
      width / (box.w + room * 2),
      height / (box.h + room * 2),
      Math.sqrt((FILL * width * height) / Math.max(1, box.w * box.h)),
    );
    if (zoom < MIN_ZOOM) return whole(video);
    return inside(video, {
      x: box.x + box.w / 2,
      y: box.y + box.h / 2 + (height / zoom) * ABOVE,
      zoom,
    });
  }

  const rectOf = (video: Scene, view: View) => {
    const w = video.size.width / view.zoom;
    const h = video.size.height / view.zoom;
    return { h, w, x: view.x - w / 2, y: view.y - h / 2 };
  };

  /** Whether going from one view to the other is a jump to elsewhere, not a pan nearby. */
  function far(video: Scene, a: View, b: View) {
    const ra = rectOf(video, a);
    const rb = rectOf(video, b);
    const w = Math.min(ra.x + ra.w, rb.x + rb.w) - Math.max(ra.x, rb.x);
    const h = Math.min(ra.y + ra.h, rb.y + rb.h) - Math.max(ra.y, rb.y);
    const shared = Math.max(0, w) * Math.max(0, h);
    return shared < NEAR * Math.min(ra.w * ra.h, rb.w * rb.h);
  }

  /** Whether a zoomed view already shows a box, with some room around it. */
  function shows(video: Scene, view: View, box: Box) {
    if (view.zoom <= 1) return false;
    const r = rectOf(video, view);
    const room = video.size.width * ROOM * 0.5;
    return (
      box.x - room >= r.x &&
      box.y - room >= r.y &&
      box.x + box.w + room <= r.x + r.w &&
      box.y + box.h + room <= r.y + r.h
    );
  }

  const same = (a: View, b: View) =>
    Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.zoom - b.zoom) < 0.005;

  /** The click made in a ring while it showed, if one was: an action, not a proof. */
  const clickIn = (video: Scene, ring: Ring) =>
    video.ripples.find(
      (p) =>
        p.at >= ring.start &&
        p.at <= endOf(ring) &&
        p.x >= ring.box.x - 8 &&
        p.x <= ring.box.x + ring.box.w + 8 &&
        p.y >= ring.box.y - 8 &&
        p.y <= ring.box.y + ring.box.h + 8,
    ) ?? null;

  /** Where the step at `at` starts: its line's start. */
  const stepStart = (video: Scene, at: number) => {
    let begin = at;
    for (const line of linesOf(video)) if (line.start <= at + 0.01) begin = line.start;
    return begin;
  };

  /**
   * Whether a line is the pointer at work where it last clicked (typing, a key): it finds
   * nothing and checks nothing of its own, and the journey does not stop at its end.
   */
  const working = (video: Scene, line: { end: number; start: number }) =>
    !video.rings.some(
      (r) =>
        (r.tone === "found" || r.tone === "missing") &&
        r.start >= line.start - 0.01 &&
        r.start < line.end,
    ) &&
    !video.checks.some((c) => c.at >= line.start - 0.05 && c.at < line.end) &&
    !video.rings.some((r) => r.tone === "missing" && Math.abs(r.start - line.end) < 0.1) &&
    !video.checks.some((c) => c.verdict === "missing" && Math.abs(c.at - line.end) < 0.1);

  /**
   * Where something happens: each control looked at or acted on (a found ring, or the
   * closest to one missing, with what it was found by and where the reference had it),
   * and the screen as a whole for each screen check.
   */
  const shotsOf = cached((video: Scene): Array<Shot> => {
    const shots: Array<Shot> = [];
    for (const ring of video.rings) {
      if (ring.tone !== "found" && ring.tone !== "missing") continue;
      let box: Box = ring.box;
      // The part it was found by, and where the reference had it, are shown with it.
      for (const other of video.rings)
        if (
          (other.tone === "by" || other.tone === "was") &&
          other.start < endOf(ring) &&
          endOf(other) > ring.start
        )
          box = union(box, other.box);
      const click = ring.tone === "found" ? clickIn(video, ring) : null;
      shots.push({
        at: ring.start,
        begin: stepStart(video, ring.start),
        box,
        click: click?.at ?? null,
        ring,
      });
    }
    for (const check of video.checks)
      if (
        (check.verdict === "same" || check.verdict === "differs") &&
        !video.rings.some((r) => Math.abs(r.start - check.at) < 0.02)
      )
        shots.push({ at: check.at, begin: check.at, box: null, click: null, ring: null });
    shots.sort((a, b) => a.at - b.at);
    // A step never sets off before the one before it happened.
    shots.forEach((shot, i) => {
      if (i) shot.begin = Math.min(shot.at, Math.max(shot.begin, shots[i - 1]!.at));
    });
    return shots;
  });

  /** The view a shot wants. */
  function viewOf(video: Scene, shot: Shot): View {
    if (!shot.box) return whole(video);
    const view = viewOn(video, shot.box);
    // A click in something too big to zoom on: in on where it clicks.
    if (view.zoom === 1 && shot.click !== null && shot.box === shot.ring?.box) {
      const at = video.ripples.find((p) => p.at === shot.click)!;
      return viewOn(video, { h: 200, w: 320, x: at.x - 160, y: at.y - 100 });
    }
    return view;
  }

  /**
   * The camera's moves, one after another (each starts once the one before has landed),
   * and when each proof is lit. The camera sets off for a step as it starts, when it is
   * free: once the step before has done what it does (its click seen, its typing done,
   * its proof read). A proof is lit as the camera lands on it, and stays lit long enough
   * to read, unless the next thing happens first.
   */
  const planOf = cached((video: Scene): Plan => {
    const shots = shotsOf(video);
    const moves: Array<Move> = [];
    const lit = new Map<Ring, { end: number; start: number }>();
    const subjects: Array<Subject> = [];
    const out = whole(video);
    let view = out;
    /** When the camera may set off again. */
    let free = 0;
    /** When the last step was done with. */
    let done = 0;
    const move = (start: number, to: View, swoop: boolean) => {
      const end = start + (swoop ? SWOOP : GLIDE);
      moves.push({ end, from: view, start, swoop, to });
      view = to;
      free = end;
      return end;
    };
    shots.forEach((shot, i) => {
      const target = viewOf(video, shot);
      // Nothing for a while: out to the whole screen, unless the next step is too close
      // for the camera to rest there.
      if (view.zoom > 1 && i > 0) {
        const idle = Math.max(free, done + IDLE);
        if (idle + GLIDE + REST <= Math.max(free, shot.begin)) move(idle, out, false);
      }
      const setOff = Math.max(free, shot.begin);
      let arrival = Math.max(free, Math.min(setOff, shot.at));
      // Where the camera already shows it, about as close, it stays.
      const kept =
        shot.box !== null &&
        target.zoom > 1 &&
        view.zoom >= target.zoom * 0.85 &&
        shows(video, view, shot.box);
      if (!same(view, target) && !kept)
        arrival = move(
          setOff,
          target,
          view.zoom > 1 && target.zoom > 1 && far(video, view, target),
        );
      const next = shots[i + 1];
      if (!shot.ring) {
        done = Math.max(arrival, shot.at);
        return;
      }
      const ring = shot.ring;
      if (shot.click !== null) {
        // A click: held while its pulse shows, and while the pointer works there after.
        done = Math.max(arrival, shot.click + AFTER_CLICK);
        for (const line of linesOf(video)) {
          if (line.start < endOf(ring) - 0.15) continue;
          if (line.start > Math.max(done, endOf(ring)) + 0.15 || !working(video, line)) break;
          done = Math.max(done, Math.min(line.end, line.start + TYPING));
        }
        subjects.push({ box: ring.box, end: done, start: shot.at, view });
        free = Math.max(free, done);
        return;
      }
      // A proof: lit once the camera is there, for long enough to read.
      const start = Math.max(ring.start, arrival - 0.1);
      let end = Math.max(endOf(ring), start + LIT);
      // Until the next thing happens; a screen check changes nothing on the screen, and
      // the camera goes out for it once the light is off.
      const cap = Math.min(
        next ? next.at + (next.ring ? 0 : GLIDE) : Infinity,
        ...video.ripples.filter((p) => p.at > ring.start).map((p) => p.at),
        video.duration,
      );
      if (ring.tone === "found") end = Math.min(end, cap);
      if (end - start < FADE * 2) end = start + FADE * 2;
      lit.set(ring, { end, start });
      subjects.push({ box: ring.box, end, start, view });
      done = end - FADE;
      free = Math.max(free, done);
    });
    // And out at the end, the journey's last screen whole, if it can get there before the
    // end; unless the video ends where the journey stopped.
    const last = shots[shots.length - 1];
    if (view.zoom > 1 && last?.ring?.tone !== "missing") {
      const start = Math.max(free, Math.min(done + IDLE, video.duration - GLIDE - 0.3));
      if (start + GLIDE <= video.duration - 0.1) move(start, out, false);
    }
    return { lit, moves, subjects };
  });

  /** Between two views: the zoom by its ratio, the centre along, eased in and out. */
  function blend(video: Scene, m: Move, t: number): View {
    const e = easeInOut(unit((t - m.start) / (m.end - m.start)));
    const { from: a, to: b } = m;
    let log = Math.log(a.zoom) + (Math.log(b.zoom) - Math.log(a.zoom)) * e;
    // Far: out to the whole screen half-way, and in again.
    if (m.swoop) log *= 1 - Math.sin(Math.PI * e);
    return inside(video, {
      x: a.x + (b.x - a.x) * e,
      y: a.y + (b.y - a.y) * e,
      zoom: Math.exp(log),
    });
  }

  function camera(video: Scene, t: number): View {
    let current: Move | null = null;
    for (const m of planOf(video).moves) {
      if (m.start > t) break;
      current = m;
    }
    if (!current) return whole(video);
    return t >= current.end ? current.to : blend(video, current, t);
  }

  // The spotlight -----------------------------------------------------------------

  function spotlight(video: Scene, t: number): Spot | null {
    let spot: Spot | null = null;
    for (const [ring, { end, start }] of planOf(video).lit) {
      if (t < start || t >= end) continue;
      spot = {
        box: ring.box,
        label: ring.label ?? null,
        labelAt: ring.labelAt ?? null,
        opacity: Math.min(unit((t - start) / FADE), unit((end - t) / FADE)),
        tone: ring.tone === "missing" ? "missing" : "found",
      };
    }
    return spot;
  }

  // The captions ------------------------------------------------------------------

  type Row = {
    block: number;
    end: number;
    /** The line it is of, in order. */
    line: number;
    start: number;
    words: Array<{ at: number; text: string }>;
  };

  const fontOf = (video: Scene) => Math.max(14, Math.round(video.size.height * 0.04));
  const rowOf = (video: Scene) => Math.round(fontOf(video) * 1.5);
  const marginOf = (video: Scene) => Math.round(video.size.height * 0.04);

  /** Every line's rows, each word with when it appears; lines close together roll as one block. */
  const rowsOf = cached((video: Scene): Array<Row> => {
    const font = fontOf(video);
    const most = Math.max(12, Math.floor((video.size.width * 0.84) / (font * 0.52)));
    const rows: Array<Row> = [];
    let block = 0;
    let lastEnd = -Infinity;
    for (const [index, line] of linesOf(video).entries()) {
      const words = line.text.split(/\s+/).filter(Boolean);
      if (!words.length) continue;
      const end = Math.max(line.end, line.start + 0.1);
      if (line.start > lastEnd + LINGER) block++;
      lastEnd = end;
      const span = Math.min((end - line.start) * PACE, words.length * WORD);
      let row: Row | null = null;
      let length = 0;
      words.forEach((text, i) => {
        const at = line.start + (span * i) / words.length;
        if (!row || length + 1 + text.length > most) {
          row = { block, end, line: index, start: at, words: [] };
          rows.push(row);
          length = text.length;
        } else length += 1 + text.length;
        row.words.push({ at, text });
      });
    }
    return rows;
  });

  /**
   * The captions' opacity: faint while what the step is about (what it clicks, or proves)
   * sits under them, so they never hide it; they stay where they are.
   */
  function clear(video: Scene, t: number) {
    const { height } = video.size;
    const band = height - marginOf(video) - rowOf(video) * 2;
    let under = 0;
    for (const { box, end, start, view } of planOf(video).subjects) {
      if (t < start - FADE || t >= end + FADE) continue;
      const top = view.y - height / view.zoom / 2;
      if ((box.y + box.h - top) * view.zoom <= band) continue;
      under = Math.max(
        under,
        Math.min(unit((t - start + FADE) / FADE), unit((end + FADE - t) / FADE)),
      );
    }
    return 1 - 0.65 * under;
  }

  function captions(video: Scene, t: number): Captions | null {
    const rows = rowsOf(video);
    let now = -1;
    for (let i = 0; i < rows.length; i++) if (rows[i]!.start <= t) now = i;
    const current = rows[now];
    if (!current || t >= current.end + LINGER) return null;
    // Two rows, and while they roll up, the one leaving above them.
    const roll = easeOut(unit((t - current.start) / ROLL));
    const shown = rows
      .slice(Math.max(0, now - (roll < 1 ? 2 : 1)), now + 1)
      .filter((r) => r.block === current.block);
    return {
      font: fontOf(video),
      opacity: clear(video, t),
      roll: shown.length > 1 ? roll : 1,
      rows: shown.map((r) => ({
        shown: r.words
          .filter((w) => w.at <= t)
          .map((w) => w.text)
          .join(" "),
        text: r.words.map((w) => w.text).join(" "),
      })),
    };
  }

  // The still ---------------------------------------------------------------------

  /**
   * The moment that stands for the video: its first proof (else where it stopped) fully
   * lit, the camera still, its caption written.
   */
  const still = cached((video: Scene): number => {
    const { lit } = planOf(video);
    const rows = rowsOf(video);
    /** The camera still for a moment, and the line at hand written to its last word. */
    const settled = (t: number) => {
      const current = rows.filter((r) => r.start <= t).pop();
      return (
        same(camera(video, t), camera(video, t + 0.2)) &&
        (!current ||
          rows.every((r) => r.line !== current.line || r.words.every((w) => w.at <= t - 0.08)))
      );
    };
    // Its first proof, else where it stopped.
    for (const tone of ["found", "missing"])
      for (const [ring, { end, start }] of lit) {
        if (ring.tone !== tone) continue;
        for (let t = start + FADE; t <= end - FADE; t += 0.04) if (settled(t)) return t;
        return Math.max(start + FADE, (start + end) / 2);
      }
    const first = shotsOf(video)[0];
    const from = first ? first.at + GLIDE : 1;
    for (let t = from; t < Math.min(video.duration, from + 3); t += 0.04) if (settled(t)) return t;
    return Math.min(from, video.duration);
  });

  // Drawing -----------------------------------------------------------------------

  /** A quiet ring and its label, as they always were drawn. */
  function quietRing(video: Scene, ring: Ring, t: number) {
    const { box } = ring;
    const pad = 5;
    const p = easeOut(unit((t - ring.start) / POP));
    const style = `opacity:${p.toFixed(3)};transform:scale(${(0.94 + 0.06 * p).toFixed(4)});transform-origin:center`;
    const color = QUIET[ring.tone]!;
    let html = `<div style="position:absolute;left:${box.x - pad}px;top:${box.y - pad}px;width:${box.w + pad * 2}px;height:${box.h + pad * 2}px;box-sizing:border-box;border:2px dashed ${color};border-radius:9px;${style}"></div>`;
    if (ring.label) {
      const wide = ring.label.length * 7.2 + 20;
      const beside = box.x + box.w + pad + 10 + wide <= video.size.width - 8;
      const left = ring.labelAt ? ring.labelAt.x : beside ? box.x + box.w + pad + 10 : box.x - pad;
      const top = ring.labelAt
        ? ring.labelAt.y
        : beside
          ? box.y + box.h / 2 - 12
          : box.y - pad - 30 < 0
            ? box.y + box.h + pad + 4
            : box.y - pad - 28;
      html += `<div style="position:absolute;left:${left}px;top:${top}px;padding:3px 9px 4px;border-radius:5px;background:${color};color:#fff;font-size:13px;font-weight:600;white-space:nowrap;${FONT};${style}">${escape(ring.label)}</div>`;
    }
    return html;
  }

  /** The marks that move with the camera: the spotlight, the quiet rings, the clicks, the pointer. */
  function worldHtml(video: Scene, t: number) {
    const parts: Array<string> = [];
    const { height, width } = video.size;
    const lit = spotlight(video, t);
    if (lit && lit.opacity > 0) {
      const { box } = lit;
      const spread = width + height;
      const dim = `0 0 18px ${spread}px rgba(0,0,0,${(DIM * lit.opacity).toFixed(3)})`;
      // An edge of its own: red where a control is missing, a faint light one where it is
      // found (unseen on a light screen, it keeps a dark one's proof apart).
      const edge = lit.tone === "missing" ? `border:2px solid ${RED};` : "";
      const glow =
        lit.tone === "found"
          ? `0 0 0 1.5px rgba(255,255,255,${(0.85 * lit.opacity).toFixed(3)}),`
          : "";
      parts.push(
        `<div style="position:absolute;left:${box.x - AROUND}px;top:${box.y - AROUND}px;width:${box.w + AROUND * 2}px;height:${box.h + AROUND * 2}px;box-sizing:border-box;border-radius:12px;${edge}box-shadow:${glow}${dim};opacity:${lit.tone === "missing" ? lit.opacity.toFixed(3) : 1}"></div>`,
      );
      if (lit.label) {
        const at = lit.labelAt ?? { x: box.x - AROUND, y: box.y + box.h + AROUND + 6 };
        parts.push(
          `<div style="position:absolute;left:${at.x}px;top:${at.y}px;padding:3px 9px 4px;border-radius:5px;background:${RED};color:#fff;font-size:13px;font-weight:600;white-space:nowrap;${FONT};opacity:${lit.opacity.toFixed(3)}">${escape(lit.label)}</div>`,
        );
      }
    }
    for (const ring of video.rings) {
      if (!QUIET[ring.tone] || t < ring.start || t >= endOf(ring)) continue;
      parts.push(quietRing(video, ring, t));
    }
    for (const click of video.ripples) {
      const p = (t - click.at) / PULSE;
      if (p < 0 || p >= 1) continue;
      const e = easeOut(p);
      parts.push(
        `<div style="position:absolute;left:${click.x - 24}px;top:${click.y - 24}px;width:48px;height:48px;box-sizing:border-box;border-radius:50%;border:3px solid ${BLUE};background:rgba(27,69,209,${(0.22 * (1 - p)).toFixed(3)});opacity:${(1 - p).toFixed(3)};transform:scale(${(0.3 + 1.1 * e).toFixed(4)})"></div>`,
      );
    }
    const at = pointer(video, t);
    if (at.opacity > 0) {
      const scale = 1 - 0.16 * at.press;
      parts.push(
        `<div style="position:absolute;left:0;top:0;transform:translate(${at.x.toFixed(1)}px,${at.y.toFixed(1)}px) scale(${scale.toFixed(3)});transform-origin:0 0;opacity:${at.opacity.toFixed(3)};filter:drop-shadow(0 2px 3px rgba(0,0,0,.4))"><div style="position:absolute;left:-3px;top:-4px;width:32px;height:41px;background:#fff;clip-path:${ARROW}"></div><div style="position:absolute;left:0;top:0;width:25px;height:33px;background:#111;clip-path:${ARROW}"></div></div>`,
      );
    }
    return parts.join("");
  }

  /** What stays put while the camera moves: the verdict in the corner and the captions. */
  function screenHtml(video: Scene, t: number, options: DrawOptions) {
    const parts: Array<string> = [];
    for (const badge of video.badges) {
      if (t < badge.start || t >= endOf(badge)) continue;
      const color = badge.tone === "fail" ? RED : badge.tone === "warn" ? DEEP : BLUE;
      parts.push(
        `<div style="position:absolute;top:16px;right:16px;padding:7px 12px 8px;border-radius:6px;background:${color};color:#fff;font-size:15px;font-weight:600;${FONT}">${escape(badge.text)}</div>`,
      );
    }
    const said = options.captions === false ? null : captions(video, t);
    if (said) {
      const row = rowOf(video);
      const rolled = ((1 - said.roll) * row).toFixed(2);
      const pad = `${Math.round(said.font * 0.08)}px ${Math.round(said.font * 0.3)}px`;
      const text = `font-size:${said.font}px;line-height:1.25;white-space:pre;${FONT}`;
      const bottom = marginOf(video) + Math.round(options.lift ?? 0);
      // While the rows roll up, the one leaving above fades out as it goes, and the new
      // one below fades in once it is clear of the frame's edge: nothing clips a row, so
      // no sliver of one ever shows.
      const rolling = said.roll < 1 && said.rows.length > 1;
      const below = Math.max(0, 1 - bottom / row);
      const shade = (i: number) =>
        !rolling
          ? 1
          : i === said.rows.length - 1
            ? unit((said.roll - below) / (1 - below))
            : i === 0 && said.rows.length > 2
              ? 1 - said.roll
              : 1;
      // Each row stands where its whole line will: the words written so far drawn from its
      // left, so a word that appears moves none of those before it.
      const rows = said.rows
        .map(
          ({ shown, text: all }, i) =>
            `<div style="height:${row}px;display:flex;align-items:center;justify-content:center;opacity:${shade(i).toFixed(3)}"><span style="position:relative;padding:${pad};${text};color:transparent">${escape(all)}${shown ? `<span style="position:absolute;left:0;top:0;padding:${pad};background:rgba(8,8,8,.75);color:#fff;${text}">${escape(shown)}</span>` : ""}</span></div>`,
        )
        .join("");
      parts.push(
        `<div style="position:absolute;left:0;right:0;bottom:${bottom}px;height:${row * 2}px;opacity:${said.opacity.toFixed(3)}"><div style="position:absolute;left:0;right:0;bottom:0;transform:translateY(${rolled}px)">${rows}</div></div>`,
      );
    }
    return parts.join("");
  }

  const drawn = new WeakMap<HTMLElement, string>();
  const paint = (layer: HTMLElement | null, html: string) => {
    if (!layer || drawn.get(layer) === html) return;
    layer.innerHTML = html;
    drawn.set(layer, html);
  };
  const part = (stage: HTMLElement, name: string) =>
    stage.querySelector<HTMLElement>(
      `:scope > [data-pom-${name}], :scope > * > [data-pom-${name}]`,
    );

  function build(stage: HTMLElement, media: HTMLElement) {
    const doc = stage.ownerDocument;
    const layer = (name: string, style: string) => {
      const element = doc.createElement("div");
      element.setAttribute(`data-pom-${name}`, "");
      element.setAttribute("style", style);
      return element;
    };
    const camera = layer("camera", "position:absolute;left:0;top:0;transform-origin:0 0");
    const world = layer("world", "position:absolute;inset:0;pointer-events:none");
    const screen = layer("screen", "position:absolute;inset:0;overflow:hidden;pointer-events:none");
    media.style.display = "block";
    media.style.position = "absolute";
    media.style.left = "0";
    media.style.top = "0";
    camera.append(media, world);
    stage.style.position ||= "relative";
    stage.style.overflow = "hidden";
    stage.append(camera, screen);
  }

  function draw(stage: HTMLElement, video: Scene, t: number, options: DrawOptions = {}) {
    const { height, width } = video.size;
    const lens = part(stage, "camera");
    if (!lens) return;
    const media = lens.firstElementChild as HTMLElement | null;
    for (const element of [stage, lens, media]) {
      if (!element) continue;
      element.style.width = `${width}px`;
      element.style.height = `${height}px`;
    }
    const view = camera(video, t);
    const left = view.x - width / view.zoom / 2;
    const top = view.y - height / view.zoom / 2;
    lens.style.transform = `scale(${view.zoom.toFixed(5)}) translate(${(-left).toFixed(3)}px, ${(-top).toFixed(3)}px)`;
    paint(part(stage, "world"), worldHtml(video, t));
    paint(part(stage, "screen"), screenHtml(video, t, options));
  }

  window.PomFrame = { build, camera, captions, draw, pointer, spotlight, still };
})();
