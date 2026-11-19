/**
 * The hand that builds a diagram on the canvas: a pointer that travels, presses, carries a box
 * from the panel, draws a frame and drags a line, the way a person does. It moves the pointer
 * on the page directly, frame by frame, rather than through React.
 */

export interface Point {
  x: number;
  y: number;
}

/** Thrown into the moves under way when the animation is stopped or skipped. */
export class Stopped extends Error {}

/** Time for the moves: it can be paused and sped up, and stopped for good. */
export class Clock {
  speed = 1;
  paused = false;
  private stopped = false;

  stop() {
    this.stopped = true;
  }

  get over() {
    return this.stopped;
  }

  /** Calls `frame` with the share of `ms` gone by, from 0 to 1, on every frame until it is 1. */
  tween(ms: number, frame: (t: number) => void): Promise<void> {
    return new Promise((done, fail) => {
      if (this.stopped) return fail(new Stopped());
      let gone = 0;
      let last = performance.now();
      const tick = (now: number) => {
        if (this.stopped) return fail(new Stopped());
        // A tab in the background does not jump ahead when it comes back.
        const step = Math.min(64, now - last);
        last = now;
        if (!this.paused) gone += step * this.speed;
        const t = ms <= 0 ? 1 : Math.min(1, gone / ms);
        frame(t);
        if (t >= 1) done();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  wait(ms: number) {
    return this.tween(ms, () => {});
  }
}

export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** How long the hand takes to cross a distance, in milliseconds: far is slower, but not in proportion. */
export const travelTime = (distance: number) => 260 + Math.min(distance, 1200) * 0.32;

export interface HandParts {
  hand: HTMLElement;
  chip: HTMLElement;
  marquee: HTMLElement;
}

export class Hand {
  private x = 0;
  private y = 0;
  private carrying = false;
  private grab: Point = { x: 18, y: 16 };
  private size = { w: 190, h: 40 };
  /** How far what is carried has turned into the box it becomes: its size on the canvas, held by its middle. */
  private morph = 0;
  private landing = 1;
  private bend = 1;

  constructor(
    private parts: HandParts,
    private clock: Clock,
  ) {}

  get at(): Point {
    return { x: this.x, y: this.y };
  }

  put(p: Point) {
    this.x = p.x;
    this.y = p.y;
    this.parts.hand.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`;
    if (!this.carrying) return;
    const m = this.morph;
    const scale = 1 + (this.landing - 1) * m;
    const gx = this.grab.x + (this.size.w / 2 - this.grab.x) * m;
    const gy = this.grab.y + (this.size.h / 2 - this.grab.y) * m;
    this.parts.chip.style.transform = `translate3d(${p.x - gx * scale}px, ${p.y - gy * scale}px, 0) scale(${scale}) rotate(${-1.5 * (1 - m)}deg)`;
  }

  show() {
    this.parts.hand.classList.add("is-on");
  }

  hide() {
    this.parts.hand.classList.remove("is-on", "is-down");
    this.letGo();
    this.parts.marquee.classList.remove("is-on");
  }

  /** Travels to a point, in a slight arc as a hand does; the point is asked again on every frame, in case the view moves. */
  async moveTo(target: () => Point, pace = 1, along?: (e: number) => void) {
    const from = this.at;
    const first = target();
    const dx = first.x - from.x;
    const dy = first.y - from.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 2) return this.put(first);
    this.bend = -this.bend;
    const lift = Math.min(80, distance * 0.15) * this.bend;
    const bow = { x: (from.x + first.x) / 2 - (dy / distance) * lift, y: (from.y + first.y) / 2 + (dx / distance) * lift };
    await this.clock.tween(travelTime(distance) * pace, (t) => {
      const e = easeInOut(t);
      const to = target();
      const u = 1 - e;
      along?.(e);
      this.put({ x: u * u * from.x + 2 * u * e * bow.x + e * e * to.x, y: u * u * from.y + 2 * u * e * bow.y + e * e * to.y });
    });
  }

  async press() {
    this.parts.hand.classList.add("is-down");
    await this.clock.wait(110);
  }

  async release() {
    this.parts.hand.classList.remove("is-down");
    await this.clock.wait(80);
  }

  /** Picks up what is being carried: a copy of the panel's tile, or a card with the box's name. */
  pickUp(content: HTMLElement, width: number, grab: Point) {
    this.parts.chip.replaceChildren(content);
    this.parts.chip.style.width = `${Math.round(width)}px`;
    this.size = { w: width, h: this.parts.chip.offsetHeight || 40 };
    this.grab = grab;
    this.morph = 0;
    this.landing = 1;
    this.carrying = true;
    this.put(this.at);
    this.parts.chip.classList.add("is-on");
  }

  /** Carries it to a box `width` wide on the canvas, turning into it on the way. */
  async carryTo(target: () => Point, width: number, pace = 1) {
    this.landing = Math.max(0.2, Math.min(2.5, width / this.size.w));
    await this.moveTo(target, pace, (e) => (this.morph = e));
  }

  letGo() {
    this.carrying = false;
    this.parts.chip.classList.remove("is-on");
  }

  /** The rectangle being drawn, from where the drag began to where the hand is. */
  frame(from: Point, to: Point) {
    const m = this.parts.marquee;
    m.style.transform = `translate3d(${Math.min(from.x, to.x)}px, ${Math.min(from.y, to.y)}px, 0)`;
    m.style.width = `${Math.abs(to.x - from.x)}px`;
    m.style.height = `${Math.abs(to.y - from.y)}px`;
    m.classList.add("is-on");
  }

  frameDone() {
    this.parts.marquee.classList.remove("is-on");
  }
}

/** A card standing for a box while it is carried, when the panel has no tile for it in view. */
export function cardFor(name: string, kind: string, color: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "build-chip__card";
  const dot = document.createElement("span");
  dot.className = "build-chip__dot";
  dot.style.background = color;
  const text = document.createElement("span");
  text.className = "build-chip__text";
  const title = document.createElement("span");
  title.className = "build-chip__name";
  title.textContent = name;
  const sub = document.createElement("span");
  sub.className = "build-chip__kind";
  sub.textContent = kind;
  text.append(title, sub);
  card.append(dot, text);
  return card;
}

/**
 * Where the hand takes a box from: its tile in the panel of components when one is in view (by
 * its library component, or its type), otherwise the panel itself, otherwise the canvas's own
 * left edge, as if brought in from outside.
 */
export function sourceOf(componentId: string | undefined, typeId: string, canvas: DOMRect, towards: number): { point: Point; tile: HTMLElement | null } {
  const panel = document.querySelector<HTMLElement>("[data-palette]");
  const clamp = (y: number, top: number, bottom: number) => Math.max(top, Math.min(bottom, y));
  if (panel && panel.offsetParent !== null) {
    const scroller = panel.querySelector<HTMLElement>("[data-palette-scroll]") ?? panel;
    const view = scroller.getBoundingClientRect();
    const inView = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return r.height > 0 && r.top >= view.top - 1 && r.bottom <= view.bottom + 1;
    };
    const tiles = [
      ...(componentId ? [...panel.querySelectorAll<HTMLElement>(`[data-component="${CSS.escape(componentId)}"]`)] : []),
      ...panel.querySelectorAll<HTMLElement>(`[data-palette-type="${CSS.escape(typeId)}"]`),
    ];
    const tile = tiles.find(inView);
    if (tile) {
      const r = tile.getBoundingClientRect();
      return { point: { x: r.left + Math.min(26, r.width / 2), y: r.top + r.height / 2 }, tile };
    }
    if (view.width > 0) return { point: { x: view.left + view.width * 0.55, y: clamp(towards, view.top + 60, view.bottom - 60) }, tile: null };
  }
  return { point: { x: canvas.left + 16, y: clamp(towards, canvas.top + 40, canvas.bottom - 40) }, tile: null };
}
