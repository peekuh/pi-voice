import type { TranscriptUpdate } from "./types.ts";

export interface TranscriptPort {
  getText(): string;
  getCursor(): { line: number; col: number };
  getLines(): string[];
  insertText(text: string): void;
  deleteBackward(graphemes: number): void;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export class TranscriptDraft {
  private pending = "";
  private expectedText: string;
  private expectedCursor: { line: number; col: number };
  private readonly port: TranscriptPort;

  constructor(port: TranscriptPort) {
    this.port = port;
    this.expectedText = port.getText();
    this.expectedCursor = { ...port.getCursor() };
  }

  update(update: TranscriptUpdate): void {
    if (!this.ownsPosition()) {
      throw new Error("Dictation stopped because the editor text or cursor changed; your edits were preserved.");
    }

    const text = update.text.replace(/[\s\u0085]+/gu, " ").replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").trim();
    const { line, col } = this.expectedCursor;
    const row = this.port.getLines()[line] ?? "";
    const left = row.slice(0, col - this.pending.length);
    const right = row.slice(col);
    const insertion = text ? `${left && !/\s$/u.test(left) ? " " : ""}${text}${right && !/^\s/u.test(right) ? " " : ""}` : "";

    if (insertion && graphemes.segment(left + insertion).containing(left.length)?.index !== left.length) {
      throw new Error("Dictation cannot insert this transcript without changing an existing character; your text was preserved.");
    }

    if (insertion !== this.pending) {
      this.removePending();
      if (insertion) this.port.insertText(insertion);
      this.rememberPosition();
    }
    this.pending = update.final ? "" : insertion;
  }

  clear(): void {
    try {
      if (this.pending && this.ownsPosition()) this.removePending();
      this.rememberPosition();
    } catch {
      // Cancellation must not interfere with an editor that is being detached.
    } finally {
      this.pending = "";
    }
  }

  private ownsPosition(): boolean {
    const cursor = this.port.getCursor();
    return this.port.getText() === this.expectedText &&
      cursor.line === this.expectedCursor.line && cursor.col === this.expectedCursor.col;
  }

  private rememberPosition(): void {
    this.expectedText = this.port.getText();
    this.expectedCursor = { ...this.port.getCursor() };
  }

  private removePending(): void {
    if (!this.pending) return;
    let count = 0;
    for (const _ of graphemes.segment(this.pending)) count++;
    this.pending = "";
    this.port.deleteBackward(count);
  }
}
