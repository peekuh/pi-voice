import assert from "node:assert/strict";
import { test } from "node:test";
import { TranscriptDraft, type TranscriptPort } from "../src/transcript.ts";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

class Editor implements TranscriptPort {
  operations: Array<{ insert: string } | { delete: number }> = [];
  unavailable = false;

  text: string;
  offset: number;

  constructor(text = "", offset = text.length) {
    this.text = text;
    this.offset = offset;
  }

  getText(): string {
    if (this.unavailable) throw new Error("Editor detached");
    return this.text;
  }

  getCursor(): { line: number; col: number } {
    const lines = this.text.slice(0, this.offset).split("\n");
    return { line: lines.length - 1, col: lines.at(-1)!.length };
  }

  getLines(): string[] { return this.text.split("\n"); }

  insertText(text: string): void {
    this.operations.push({ insert: text });
    this.text = this.text.slice(0, this.offset) + text + this.text.slice(this.offset);
    this.offset += text.length;
  }

  deleteBackward(count: number): void {
    this.operations.push({ delete: count });
    for (let i = 0; i < count; i++) {
      const previous = [...graphemes.segment(this.text.slice(0, this.offset))].at(-1);
      if (!previous) continue;
      this.text = this.text.slice(0, previous.index) + this.text.slice(this.offset);
      this.offset = previous.index;
    }
  }
}

test("interim revisions grow and shrink the owned span without duplicating hypotheses", () => {
  const editor = new Editor();
  const draft = new TranscriptDraft(editor);
  draft.update({ text: "hello", final: false });
  assert.equal(editor.text, "hello");
  draft.update({ text: "hello world", final: false });
  assert.equal(editor.text, "hello world");
  draft.update({ text: "he", final: false });
  assert.equal(editor.text, "he");
  draft.update({ text: "Hello world.", final: true });
  assert.equal(editor.text, "Hello world.");
  draft.clear();
  assert.equal(editor.text, "Hello world.");
});

test("an unchanged interim and identical final commit do not mutate the editor", () => {
  const editor = new Editor("prefix");
  const draft = new TranscriptDraft(editor);
  draft.update({ text: "hello world", final: false });
  const operations = [...editor.operations];
  draft.update({ text: " hello   world ", final: false });
  draft.update({ text: "hello world", final: true });
  assert.deepEqual(editor.operations, operations);
  draft.clear();
  assert.equal(editor.text, "prefix hello world");
  assert.deepEqual(editor.operations, operations);
});

test("the next segment appends, including intentional repeated final segments", () => {
  const editor = new Editor();
  const draft = new TranscriptDraft(editor);
  draft.update({ text: "hello", final: false });
  draft.update({ text: "hello", final: true });
  draft.update({ text: "again", final: true });
  draft.update({ text: "again", final: true });
  assert.equal(editor.text, "hello again again");
  draft.update({ text: "new", final: false });
  draft.update({ text: "new segment", final: false });
  draft.update({ text: "New segment.", final: true });
  assert.equal(editor.text, "hello again again New segment.");
});

test("an empty final clears the previous interim but retains committed segments", () => {
  const editor = new Editor();
  const draft = new TranscriptDraft(editor);
  draft.update({ text: "retained", final: true });
  draft.update({ text: "discard me", final: false });
  draft.update({ text: " \r\n\t\u0000", final: true });
  assert.equal(editor.text, "retained");
  assert.equal(editor.offset, "retained".length);
  draft.update({ text: "", final: true });
  draft.update({ text: "next", final: true });
  assert.equal(editor.text, "retained next");
});

test("cancellation removes only the current preview and can be repeated safely", () => {
  const editor = new Editor("start");
  const draft = new TranscriptDraft(editor);
  draft.update({ text: "final", final: true });
  draft.update({ text: "temporary", final: false });
  draft.clear();
  draft.clear();
  assert.equal(editor.text, "start final");
  assert.equal(editor.offset, "start final".length);
  draft.update({ text: "new session", final: true });
  assert.equal(editor.text, "start final new session");
});

test("middle-of-draft revisions preserve surrounding lines, suffix, and insertion cursor", () => {
  const prefix = "before\nalpha";
  const suffix = "omega\nafter";
  const editor = new Editor(prefix + suffix, prefix.length);
  const draft = new TranscriptDraft(editor);
  draft.update({ text: "hello", final: false });
  assert.equal(editor.text, `${prefix} hello ${suffix}`);
  assert.deepEqual(editor.getCursor(), { line: 1, col: "alpha hello ".length });
  draft.update({ text: "Hello world.", final: true });
  draft.update({ text: "again", final: true });
  assert.equal(editor.text, `${prefix} Hello world. again ${suffix}`);
  assert.deepEqual(editor.getCursor(), { line: 1, col: "alpha Hello world. again ".length });
  draft.update({ text: "discarded", final: false });
  draft.clear();
  assert.equal(editor.text, `${prefix} Hello world. again ${suffix}`);
  assert.deepEqual(editor.getCursor(), { line: 1, col: "alpha Hello world. again ".length });
});

test("existing whitespace at either boundary is not duplicated or removed", () => {
  const editor = new Editor("left  \tright", "left ".length);
  const draft = new TranscriptDraft(editor);
  draft.update({ text: " hello ", final: false });
  assert.equal(editor.text, "left hello \tright");
  draft.clear();
  assert.equal(editor.text, "left  \tright");
  assert.equal(editor.offset, "left ".length);
});

test("Unicode deletion counts graphemes, including combining marks and joined emoji", () => {
  const editor = new Editor("beforeafter", "before".length);
  const draft = new TranscriptDraft(editor);
  draft.update({ text: "e\u0301👩🏽‍💻🇺🇸", final: false });
  draft.update({ text: "é", final: false });
  assert.deepEqual(editor.operations[1], { delete: 5 });
  assert.equal(editor.text, "before é after");
  draft.clear();
  assert.deepEqual(editor.operations[3], { delete: 3 });
  assert.equal(editor.text, "beforeafter");
  assert.equal(editor.offset, "before".length);
});

test("line breaks become spaces and control bytes cannot reach the editor", () => {
  const editor = new Editor();
  const draft = new TranscriptDraft(editor);
  draft.update({ text: " \thello\r\n  world\u0085next\u0000!\u001b\u007f\u009f ", final: false });
  assert.equal(editor.text, "hello world next!");
  assert.equal(editor.getLines().length, 1);
  draft.clear();
  assert.equal(editor.text, "");
});

test("external text edits make updates fail without appending or removing any text", () => {
  const editor = new Editor();
  const draft = new TranscriptDraft(editor);
  draft.update({ text: "hello", final: false });
  editor.insertText(" user edit");
  const operations = [...editor.operations];
  assert.throws(() => draft.update({ text: "hello world", final: true }), /editor text or cursor changed.*preserved/);
  assert.equal(editor.text, "hello user edit");
  draft.clear();
  assert.equal(editor.text, "hello user edit");
  assert.deepEqual(editor.operations, operations);
});

test("cursor movement loses preview ownership even if editor text is unchanged", () => {
  const editor = new Editor("leftright", 4);
  const draft = new TranscriptDraft(editor);
  draft.update({ text: "hello", final: false });
  editor.offset = 0;
  const operations = [...editor.operations];
  assert.throws(() => draft.update({ text: "revised", final: false }), /editor text or cursor changed/);
  draft.clear();
  assert.equal(editor.text, "left hello right");
  assert.equal(editor.offset, 0);
  assert.deepEqual(editor.operations, operations);
});

test("external edits after a final segment are not a new insertion anchor until clear", () => {
  const editor = new Editor();
  const draft = new TranscriptDraft(editor);
  draft.update({ text: "hello", final: true });
  editor.insertText(" user");
  assert.throws(() => draft.update({ text: "next", final: true }), /editor text or cursor changed/);
  draft.clear();
  draft.update({ text: "next", final: true });
  assert.equal(editor.text, "hello user next");
});

test("clear does not throw when the editor has been detached", () => {
  const editor = new Editor();
  const draft = new TranscriptDraft(editor);
  draft.update({ text: "hello", final: false });
  editor.unavailable = true;
  assert.doesNotThrow(() => draft.clear());
  assert.equal(editor.text, "hello");
});

test("a leading combining mark never takes ownership of an existing space", () => {
  const editor = new Editor("prefix ");
  const draft = new TranscriptDraft(editor);
  assert.throws(() => draft.update({ text: "\u0301", final: false }), /without changing an existing character/);
  draft.clear();
  assert.equal(editor.text, "prefix ");
  assert.deepEqual(editor.operations, []);
});

class NativePreviewEditor extends Editor {
  private previewLength = 0;
  private history: Array<{ text: string; offset: number }> = [];

  nativePreview = {
    set: (text: string) => {
      this.dropPreview();
      this.insertText(text);
      this.previewLength = text.length;
    },
    commit: (text: string) => {
      this.dropPreview();
      this.history.push({ text: this.text, offset: this.offset });
      this.insertText(text);
    },
    clear: () => this.dropPreview(),
  };

  private dropPreview(): void {
    this.text = this.text.slice(0, this.offset - this.previewLength) + this.text.slice(this.offset);
    this.offset -= this.previewLength;
    this.previewLength = 0;
  }

  undo(): void {
    const prior = this.history.pop();
    if (prior) {
      this.text = prior.text;
      this.offset = prior.offset;
    }
  }
}

test("native provisional updates do not become separate undo steps and identical finals commit", () => {
  const editor = new NativePreviewEditor("left right", 5);
  const draft = new TranscriptDraft(editor);
  draft.update({ text: "hello", final: false });
  draft.update({ text: "hello world", final: false });
  draft.update({ text: "hello world", final: true });
  assert.equal(editor.text, "left hello world right");
  draft.update({ text: "temporary", final: false });
  draft.clear();
  assert.equal(editor.text, "left hello world right");
  editor.undo();
  assert.equal(editor.text, "left right");
  assert.equal(editor.offset, 5);
});

test("lost native-preview ownership cannot delete user edits on cancellation or a later dictation", () => {
  const editor = new NativePreviewEditor("prefix ");
  const draft = new TranscriptDraft(editor);
  draft.update({ text: "preview", final: false });
  editor.insertText(" user edit");
  draft.clear();
  assert.equal(editor.text, "prefix preview user edit");
  assert.throws(() => draft.update({ text: "later speech", final: false }), /lost its editor position/);
  assert.equal(editor.text, "prefix preview user edit");
});
