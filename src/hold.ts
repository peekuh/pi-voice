export interface Clock {
  now(): number;
  set(callback: () => void, ms: number): unknown;
  clear(timer: unknown): void;
}

const clock: Clock = {
  now: () => performance.now(),
  set: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    timer.unref();
    return timer;
  },
  clear: timer => clearTimeout(timer as NodeJS.Timeout),
};

const repeatMaxGapMs = 120;
const repeatJitterMs = 18;
const repeatJitterRatio = 0.35;
const mechanicalRunLength = 2;
const stallSlackMs = 100;

export interface HoldOptions {
  holdMs: number;
  releaseMs: number;
  canRecord(): boolean;
  tap(count: number): void;
  removeTaps(count: number): void;
  start(): void;
  stop(): void;
}

export class SpaceHold {
  private options: HoldOptions;
  private clock: Clock;
  private startedAt: number | undefined;
  private lastAt = 0;
  private previousGap: number | undefined;
  private mechanicalRun = 0;
  private firstDelay = false;
  private typed = 0;
  private lastTyped = 0;
  private held = false;
  private releaseTimer: unknown;
  private timerGeneration = 0;

  constructor(options: HoldOptions, timerClock: Clock = clock) {
    this.options = options;
    this.clock = timerClock;
  }

  press(count = 1): void {
    if (this.held) {
      this.armRelease(this.options.releaseMs);
      return;
    }
    if (!this.options.canRecord()) {
      this.reset();
      this.options.tap(count);
      return;
    }

    const now = this.clock.now();
    const initialWindow = Math.max(1000, this.options.holdMs + repeatMaxGapMs);
    if (this.startedAt === undefined) {
      this.startedAt = now;
      this.lastAt = now;
      this.typeTap(count);
      this.armRelease(initialWindow);
      return;
    }

    const gap = now - this.lastAt;
    if (gap < 8) {
      // Pi can split one received burst into callbacks a fraction of a millisecond apart.
      // Their delivery spacing is not a new OS repeat interval.
      this.typeTap(count);
      this.armRelease(this.previousGap === undefined ? initialWindow : this.options.releaseMs);
      return;
    }
    const previousAt = this.lastAt;
    this.lastAt = now;
    const previousGap = this.previousGap;
    if (previousGap === undefined && gap <= initialWindow) {
      this.firstDelay = gap > repeatMaxGapMs;
    } else {
      const mechanical = previousGap !== undefined && gap > 0 && previousGap > 0
        && gap <= repeatMaxGapMs && previousGap <= repeatMaxGapMs
        && Math.abs(gap - previousGap) <= Math.max(repeatJitterMs, Math.min(gap, previousGap) * repeatJitterRatio);
      if (mechanical) {
        this.mechanicalRun++;
      } else {
        this.mechanicalRun = 0;
        if (!(this.firstDelay && gap > 0 && gap <= repeatMaxGapMs)) {
          const retainPrevious = previousGap !== undefined && previousGap > repeatMaxGapMs
            && gap > 0 && gap <= repeatMaxGapMs;
          this.typed = retainPrevious ? this.lastTyped : 0;
          this.startedAt = retainPrevious ? previousAt : now;
        }
      }
      this.firstDelay = false;
    }
    this.previousGap = gap;
    this.lastTyped = 0;

    if (this.mechanicalRun >= mechanicalRunLength && now - this.startedAt >= this.options.holdMs) {
      const typed = this.typed;
      this.typed = 0;
      this.held = true;
      this.armRelease(this.options.releaseMs);
      if (typed > 0) this.options.removeTaps(typed);
      this.options.start();
      return;
    }
    this.typeTap(count);
    this.armRelease(this.options.releaseMs);
  }

  private typeTap(count: number): void {
    this.options.tap(count);
    this.typed += count;
    this.lastTyped += count;
  }

  private armRelease(delay: number): void {
    this.clock.clear(this.releaseTimer);
    const generation = ++this.timerGeneration;
    const armedAt = this.clock.now();
    this.releaseTimer = this.clock.set(() => {
      if (generation !== this.timerGeneration) return;
      this.releaseTimer = undefined;
      if (this.clock.now() - armedAt > delay + stallSlackMs) {
        this.armRelease(delay);
        return;
      }
      this.release();
    }, delay);
  }

  release(): void {
    const held = this.held;
    this.reset();
    if (held) this.options.stop();
  }

  reset(): void {
    this.clock.clear(this.releaseTimer);
    this.releaseTimer = undefined;
    this.timerGeneration++;
    this.startedAt = undefined;
    this.previousGap = undefined;
    this.mechanicalRun = 0;
    this.firstDelay = false;
    this.typed = 0;
    this.lastTyped = 0;
    this.held = false;
  }
}
