# Changelog

## Unreleased

- Match OMP-style held-key suppression using repeat cadence rather than treating Kitty negotiation as a guarantee of repeat/release labels.
- Handle batched spaces and Pi-split sub-millisecond bursts without advancing the cursor during an active hold. Preserve immediate taps and safely roll back only owned candidate spaces.
- Default to Deepgram realtime WebSocket transcription with continuous PCM, revisable interim text, per-segment final commits, and clean finalization on release.
- Preserve Groq as a separately labelled phrase-HTTP option with silence filtering and ordered quota-spaced requests.
- Import both provider keys from a labelled Desktop file into separate private key files.

## 0.1.0 — 2026-11-03

- Pi-only held-Space microphone dictation with Groq Whisper and Deepgram prerecorded transcription.
- Ordinary Space taps, Kitty key-release handling, legacy repeat-gap handling, and Ctrl+Shift+R recording toggle.
- Cursor insertion without auto-send; cancellation on Escape, focus loss, submission, and session shutdown.
- In-memory ffmpeg recording, bounded duration, request timeout, and no implicit provider fallback.
- Private key-file installation and persisted provider selection.

Verified with Pi 1.2.0 on Linux: microphone capture, live Groq transcription, real Pi legacy/Kitty input smokes, and 47 regression tests plus TypeScript checking. Deepgram transport is covered by request/response tests; a live check requires a Deepgram key. OMP is not supported in this release.
