import assert from "node:assert/strict";
import { test } from "node:test";
import { Dictation, type VoiceState } from "../src/controller.ts";
import { loadConfig } from "../src/config.ts";
import type { Recording, StartTranscriptionStream, TranscriptUpdate } from "../src/types.ts";
import { TranscriptDraft } from "../src/transcript.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("cancelled or unfocused requests cannot insert into a newer draft or reset a newer recording", async () => {
  const dir = await mkdtemp(join(tmpdir(), "voice-controller-"));
  try {
    const config = await loadConfig(join(dir, "missing.json"));
    let focused = true;
    const inserted: string[] = [];
    const states: VoiceState[] = [];
    const errors: string[] = [];
    const replies: Array<{ emit: (update: TranscriptUpdate) => void; finish: () => void }> = [];
    const signals: AbortSignal[] = [];
    let cancelled = 0;
    const controller = new Dictation({
      focused: () => focused,
      update: update => { if (update.final) inserted.push(update.text); },
      clearPreview: () => {},
      state: state => { states.push(state); },
      error: message => { errors.push(message); },
    }, (): Recording => ({
      stop: async () => new Uint8Array([1, 2]),
      cancel: () => { cancelled++; },
    }), (_config, signal, onText) => {
      signals.push(signal);
      const { promise, resolve } = Promise.withResolvers<void>();
      replies.push({ emit: onText, finish: resolve });
      return { pushAudio: () => {}, finish: () => promise, cancel: () => {} };
    });
    controller.start(config);
    const stale = controller.stop();
    await Promise.resolve();
    controller.cancel();
    assert.equal(signals[0].aborted, true);
    controller.start(config);
    replies[0].emit({ text: "stale transcript", final: true });
    replies[0].finish();
    await stale;
    assert.equal(controller.state, "recording");
    assert.deepEqual(inserted, []);
    assert.equal(cancelled, 1);
    const current = controller.stop();
    await Promise.resolve();
    focused = false;
    replies[1].emit({ text: "wrong editor transcript", final: true });
    replies[1].finish();
    await current;
    assert.deepEqual(inserted, []);
    assert.equal(controller.state, "idle");
    assert.deepEqual(errors, []);
    assert.ok(states.includes("transcribing"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("recorder failure returns to idle and a later dictation still works", async () => {
  const dir = await mkdtemp(join(tmpdir(), "voice-recovery-"));
  try {
    const config = await loadConfig(join(dir, "missing.json"));
    const errors: string[] = [];
    const inserted: string[] = [];
    let fail: (error: Error) => void = () => {};
    const startStream: StartTranscriptionStream = (_config, _signal, onText) => ({
      pushAudio: () => {},
      finish: async () => { onText({ text: "recovered speech", final: true }); },
      cancel: () => {},
    });
    const controller = new Dictation({
      focused: () => true,
      update: update => { if (update.final) inserted.push(update.text); },
      clearPreview: () => {},
      state: () => {},
      error: message => { errors.push(message); },
    }, (_config, onError) => {
      fail = onError;
      return { stop: async () => new Uint8Array([1, 2]), cancel: () => {} };
    }, startStream);
    controller.start(config);
    fail(new Error("microphone disconnected"));
    assert.equal(controller.state, "idle");
    assert.deepEqual(errors, ["microphone disconnected"]);
    controller.start(config);
    await controller.stop();
    assert.deepEqual(inserted, ["recovered speech"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("interims revise in place and cancellation removes only the uncommitted hypothesis", async () => {
  const dir = await mkdtemp(join(tmpdir(), "voice-realtime-"));
  try {
    const config = await loadConfig(join(dir, "missing.json"));
    let draft = "existing draft";
    let cursor = draft.length;
    const transcript = new TranscriptDraft({
      getText: () => draft,
      getCursor: () => ({ line: 0, col: cursor }),
      getLines: () => [draft],
      insertText: text => {
        draft = draft.slice(0, cursor) + text + draft.slice(cursor);
        cursor += text.length;
      },
      deleteBackward: count => {
        draft = draft.slice(0, cursor - count) + draft.slice(cursor);
        cursor -= count;
      },
    });
    let emit: (update: TranscriptUpdate) => void = () => {};
    const controller = new Dictation({
      focused: () => true,
      update: update => transcript.update(update),
      clearPreview: () => transcript.clear(),
      state: () => {},
      error: message => { throw new Error(message); },
    }, () => ({ stop: async () => new Uint8Array(), cancel: () => {} }),
    (_config, _signal, onText) => {
      emit = onText;
      return { pushAudio: () => {}, finish: async () => {}, cancel: () => {} };
    });
    controller.start(config);
    emit({ text: "first", final: false });
    assert.equal(draft, "existing draft first");
    emit({ text: "first utterance", final: false });
    assert.equal(controller.state, "recording");
    assert.equal(draft, "existing draft first utterance");
    emit({ text: "first utterance", final: true });
    assert.equal(draft, "existing draft first utterance");
    emit({ text: "second", final: false });
    assert.equal(draft, "existing draft first utterance second");
    controller.cancel();
    assert.equal(draft, "existing draft first utterance");
    emit({ text: "late response", final: true });
    assert.equal(draft, "existing draft first utterance");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("microphone level follows only the current recording and resets when recording ends", async () => {
  const dir = await mkdtemp(join(tmpdir(), "voice-audio-level-"));
  try {
    const config = await loadConfig(join(dir, "missing.json"));
    const audio: Array<(pcm: Uint8Array) => void> = [];
    const controller = new Dictation({
      focused: () => true,
      update: () => {},
      clearPreview: () => {},
      state: () => {},
      error: () => {},
    }, (_config, _error, onAudio) => {
      audio.push(onAudio!);
      return { stop: async () => new Uint8Array(), cancel: () => {} };
    }, () => ({ pushAudio: () => {}, finish: async () => {}, cancel: () => {} }));
    const loud = Buffer.alloc(3200);
    for (let offset = 0; offset < loud.length; offset += 2) loud.writeInt16LE(16_384, offset);
    controller.start(config);
    assert.equal(controller.audioLevel, 0);
    assert.equal(controller.audioActive, false);
    audio[0](loud);
    assert.ok(controller.audioLevel > 0.75);
    assert.equal(controller.audioActive, true);
    await controller.stop();
    assert.equal(controller.audioLevel, 0);
    assert.equal(controller.audioActive, false);
    controller.start(config);
    audio[0](loud);
    assert.equal(controller.audioLevel, 0);
    assert.equal(controller.audioActive, false);
    audio[1](loud);
    assert.ok(controller.audioLevel > 0.75);
    controller.cancel();
    audio[1](loud);
    assert.equal(controller.audioLevel, 0);
    assert.equal(controller.audioActive, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
