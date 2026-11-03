import assert from "node:assert/strict";
import { test } from "node:test";
import { SpaceHold, type Clock } from "../src/hold.ts";

class FakeClock implements Clock {
  time = 0;
  next = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.time; }
  set(callback: () => void, ms: number): number {
    const id = ++this.next;
    this.timers.set(id, { at: this.time + ms, callback });
    return id;
  }
  clear(id: unknown): void { this.timers.delete(id as number); }
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at).find(([, timer]) => timer.at <= end);
      if (!next) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.time = end;
  }
  stall(ms: number): void {
    this.time += ms;
    const ready = [...this.timers].filter(([, timer]) => timer.at <= this.time);
    for (const [id, timer] of ready) {
      if (!this.timers.delete(id)) continue;
      timer.callback();
    }
  }
}

function setup(holdMs = 600) {
  const clock = new FakeClock();
  const events: string[] = [];
  const tapped: number[] = [];
  const removed: number[] = [];
  const draft = { text: "alphaomega", cursor: 5 };
  let focused = true;
  const hold = new SpaceHold({
    holdMs,
    releaseMs: 250,
    canRecord: () => focused,
    tap: count => {
      tapped.push(count);
      events.push(...Array<string>(count).fill("space"));
      draft.text = `${draft.text.slice(0, draft.cursor)}${" ".repeat(count)}${draft.text.slice(draft.cursor)}`;
      draft.cursor += count;
    },
    removeTaps: count => {
      assert.equal(draft.text.slice(draft.cursor - count, draft.cursor), " ".repeat(count));
      removed.push(count);
      draft.text = draft.text.slice(0, draft.cursor - count) + draft.text.slice(draft.cursor);
      draft.cursor -= count;
    },
    start: () => { events.push("record"); },
    stop: () => { events.push("stop"); },
  }, clock);
  return { hold, clock, events, tapped, removed, draft, blur: () => { focused = false; } };
}

function startHold(hold: SpaceHold, clock: FakeClock): void {
  hold.press();
  clock.advance(500);
  hold.press();
  for (let i = 0; i < 3; i++) {
    clock.advance(40);
    hold.press();
  }
}

test("normal taps insert literal spaces immediately, including explicit down/up events", () => {
  const { hold, clock, events, draft } = setup();
  hold.press();
  assert.deepEqual(events, ["space"]);
  assert.equal(draft.text, "alpha omega");
  clock.advance(60);
  hold.release();
  hold.press();
  assert.deepEqual(events, ["space", "space"]);
  hold.release();
  clock.advance(2000);
  assert.equal(draft.text, "alpha  omega");
});

test("a lone tap never starts a microphone or disappears", () => {
  const { hold, clock, events } = setup();
  hold.press();
  clock.advance(3000);
  assert.deepEqual(events, ["space"]);
  assert.equal(clock.timers.size, 0);
});

test("unlabelled repeated presses recognize a hold without any Kitty release guarantee", () => {
  const { hold, clock, events, removed, draft } = setup();
  startHold(hold, clock);
  assert.deepEqual(events, ["space", "space", "space", "space", "record"]);
  assert.deepEqual(removed, [4]);
  assert.deepEqual(draft, { text: "alphaomega", cursor: 5 });
  clock.advance(249);
  assert.equal(events.at(-1), "record");
  clock.advance(1);
  assert.equal(events.at(-1), "stop");
});

test("a slow first repeat retains and rolls back the initial owned space", () => {
  const { hold, clock, events, removed, draft } = setup();
  hold.press();
  clock.advance(900);
  hold.press();
  for (let i = 0; i < 3; i++) {
    clock.advance(40);
    hold.press();
  }
  assert.deepEqual(removed, [4]);
  assert.equal(events.at(-1), "record");
  assert.equal(draft.cursor, 5);
});

test("cadence needs two consecutive mechanical comparisons", () => {
  const { hold, clock, events, removed } = setup(0);
  hold.press();
  clock.advance(40);
  hold.press();
  clock.advance(40);
  hold.press();
  assert.deepEqual(events, ["space", "space", "space"]);
  clock.advance(40);
  hold.press();
  assert.deepEqual(removed, [3]);
  assert.equal(events.at(-1), "record");
});

test("the minimum hold duration is retained even when cadence is already steady", () => {
  const { hold, clock, events, removed } = setup();
  hold.press();
  for (let i = 0; i < 14; i++) {
    clock.advance(40);
    hold.press();
  }
  assert.equal(events.includes("record"), false);
  clock.advance(40);
  hold.press();
  assert.equal(events.at(-1), "record");
  assert.deepEqual(removed, [15]);
});

test("a short metronomic tap sequence never activates later on a timer", () => {
  const { hold, clock, events, removed } = setup();
  hold.press();
  for (let i = 0; i < 3; i++) {
    clock.advance(40);
    hold.press();
  }
  clock.advance(2000);
  assert.deepEqual(events, ["space", "space", "space", "space"]);
  assert.deepEqual(removed, []);
});

test("fast irregular human spaces remain immediate literal typing", () => {
  const { hold, clock, events, removed } = setup();
  hold.press();
  const gaps = [20, 105, 25, 110, 30, 100, 20, 105, 25, 110, 30, 100];
  for (const gap of gaps) {
    clock.advance(gap);
    hold.press();
    assert.equal(events.at(-1), "space");
  }
  clock.advance(2000);
  assert.equal(events.length, gaps.length + 1);
  assert.deepEqual(removed, []);
});

test("jitter tolerance accepts steady repeat drift but not slow typing", () => {
  const steady = setup(0);
  steady.hold.press();
  for (const gap of [30, 45, 35]) {
    steady.clock.advance(gap);
    steady.hold.press();
  }
  assert.equal(steady.events.at(-1), "record");
  const slow = setup(0);
  slow.hold.press();
  for (let i = 0; i < 8; i++) {
    slow.clock.advance(130);
    slow.hold.press();
  }
  assert.equal(slow.events.includes("record"), false);
  assert.deepEqual(slow.removed, []);
});

test("every active repeat packet is swallowed and re-arms release", () => {
  const { hold, clock, events, removed, draft } = setup();
  startHold(hold, clock);
  const tapCount = events.filter(event => event === "space").length;
  for (let i = 0; i < 30; i++) {
    clock.advance(100);
    hold.press(i % 2 === 0 ? 1 : 3);
  }
  assert.equal(events.filter(event => event === "space").length, tapCount);
  assert.equal(events.filter(event => event === "record").length, 1);
  assert.equal(events.includes("stop"), false);
  assert.deepEqual(removed, [4]);
  assert.equal(draft.cursor, 5);
  clock.advance(250);
  assert.equal(events.filter(event => event === "stop").length, 1);
});

test("one all-space packet is literal typing, not cadence evidence", () => {
  const { hold, clock, events, tapped, removed } = setup();
  hold.press(8);
  clock.advance(2000);
  assert.deepEqual(events, Array<string>(8).fill("space"));
  assert.deepEqual(tapped, [8]);
  assert.deepEqual(removed, []);
});

test("batched initial spaces are all owned and removed when a later cadence confirms a hold", () => {
  const { hold, clock, events, removed, draft } = setup();
  hold.press(3);
  clock.advance(500);
  hold.press(3);
  for (let i = 0; i < 3; i++) {
    clock.advance(40);
    hold.press();
  }
  assert.equal(events.at(-1), "record");
  assert.deepEqual(removed, [8]);
  assert.deepEqual(draft, { text: "alphaomega", cursor: 5 });
});

test("sustained batched packets establish cadence once per packet and roll back all literal units", () => {
  const { hold, clock, events, tapped, removed, draft } = setup();
  hold.press(3);
  clock.advance(500);
  hold.press(3);
  for (let i = 0; i < 3; i++) {
    clock.advance(40);
    hold.press(3);
  }
  assert.equal(events.at(-1), "record");
  assert.deepEqual(tapped, [3, 3, 3, 3]);
  assert.deepEqual(removed, [12]);
  assert.deepEqual(draft, { text: "alphaomega", cursor: 5 });
});

test("same-timestamp queued packets neither count as repeat cadence nor break an established cadence", () => {
  const { hold, clock, events, removed } = setup();
  hold.press();
  hold.press(2);
  clock.advance(500);
  hold.press();
  hold.press(2);
  for (let i = 0; i < 3; i++) {
    clock.advance(40);
    hold.press();
    hold.press(2);
  }
  assert.equal(events.at(-1), "record");
  assert.deepEqual(removed, [12]);
});

test("a batch during active hold never inserts spaces or triggers an early stop", () => {
  const { hold, clock, events, draft } = setup();
  startHold(hold, clock);
  clock.advance(240);
  hold.press(30);
  clock.advance(249);
  assert.equal(events.at(-1), "record");
  assert.equal(draft.text, "alphaomega");
  clock.advance(1);
  assert.equal(events.at(-1), "stop");
});

test("late release timers wait for queued input to drain after an event-loop stall", () => {
  const { hold, clock, events } = setup();
  startHold(hold, clock);
  clock.stall(600);
  assert.equal(events.at(-1), "record");
  hold.press();
  hold.press();
  clock.advance(249);
  assert.equal(events.at(-1), "record");
  clock.advance(1);
  assert.equal(events.at(-1), "stop");
});

test("stall deferral is bounded when there are no queued repeats", () => {
  const { hold, clock, events } = setup();
  startHold(hold, clock);
  clock.stall(600);
  clock.advance(250);
  assert.equal(events.at(-1), "stop");
  assert.equal(clock.timers.size, 0);
});

test("timer lateness of at most 100ms still ends the hold", () => {
  const { hold, clock, events } = setup();
  startHold(hold, clock);
  clock.stall(350);
  assert.equal(events.at(-1), "stop");
});

test("explicit release stops once immediately and stale timers cannot stop a new hold", () => {
  const { hold, clock, events } = setup();
  startHold(hold, clock);
  hold.release();
  hold.release();
  assert.equal(events.filter(event => event === "stop").length, 1);
  startHold(hold, clock);
  assert.equal(events.filter(event => event === "record").length, 2);
  clock.advance(250);
  assert.equal(events.filter(event => event === "stop").length, 2);
});

test("reset keeps already typed spaces and cancels without duplicate insertion or callbacks", () => {
  const { hold, clock, events, removed } = setup();
  hold.press();
  hold.reset();
  hold.reset();
  clock.advance(2000);
  assert.deepEqual(events, ["space"]);
  startHold(hold, clock);
  hold.reset();
  hold.reset();
  clock.advance(2000);
  assert.equal(events.includes("stop"), false);
  assert.deepEqual(removed, [4]);
  assert.equal(clock.timers.size, 0);
});

test("disabled recording preserves taps and never rolls back or activates", () => {
  const { hold, clock, events, removed, blur } = setup();
  hold.press();
  blur();
  for (let i = 0; i < 20; i++) {
    clock.advance(40);
    hold.press();
  }
  clock.advance(2000);
  assert.deepEqual(events, Array<string>(21).fill("space"));
  assert.deepEqual(removed, []);
});

test("rollback excludes finalized spaces before an irregular cadence break", () => {
  const { hold, clock, events, removed, draft } = setup(0);
  hold.press();
  clock.advance(30);
  hold.press();
  clock.advance(100);
  hold.press();
  for (let i = 0; i < 3; i++) {
    clock.advance(40);
    hold.press();
  }
  assert.equal(events.at(-1), "record");
  assert.deepEqual(removed, [2]);
  assert.equal(draft.text, "alpha   omega");
  assert.equal(draft.cursor, 8);
});

test("Pi-split repeat bursts with fractional delivery gaps stop the cursor and retain OS cadence", () => {
  const { hold, clock, events, draft } = setup();
  hold.press();
  clock.advance(500);
  for (let packet = 0; packet < 10; packet++) {
    hold.press();
    clock.advance(0.2);
    hold.press();
    clock.advance(0.3);
    hold.press();
    clock.advance(34.5);
  }
  assert.equal(events.filter(event => event === "record").length, 1);
  assert.deepEqual(draft, { text: "alphaomega", cursor: 5 });
  const before = { ...draft };
  for (let packet = 0; packet < 20; packet++) {
    hold.press();
    clock.advance(0.4);
    hold.press();
    clock.advance(34.6);
  }
  assert.deepEqual(draft, before);
  clock.advance(250);
  assert.equal(events.at(-1), "stop");
});
