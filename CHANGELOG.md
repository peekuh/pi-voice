# Changelog

## Unreleased

- Match OMP-style held-key suppression using repeat cadence rather than treating Kitty negotiation as a guarantee of repeat/release labels.
- Handle batched spaces and Pi-split sub-millisecond bursts without advancing the cursor during an active hold. Preserve immediate taps and safely roll back only owned candidate spaces.
- Default to Deepgram realtime WebSocket transcription with continuous PCM, revisable interim text, per-segment final commits, and clean finalization on release.
- Preserve Groq as a separately labelled phrase-HTTP option with silence filtering and ordered quota-spaced requests.
- Import both provider keys from a labelled Desktop file into separate private key files.
- Add a real-Pi live smoke that observes continuous WebSocket PCM, actual interim results before the first pause, zero Deepgram HTTP uploads, clean finalization, and cancellation of provisional text. Both Deepgram realtime and Groq phrase modes passed with real credentials.
- Add a microphone-reactive software cursor with eight sound-driven height levels, cycling color, steady finalization state, exact caret restoration, reduced-motion and no-color modes.
- Extend the live-Pi smoke with actual quiet/loud cursor-render captures, color progression, reduced-motion and monochrome checks, steady finalization and native-cursor restoration; write observer snapshots atomically.
- Stabilize the recording cursor: cache presentation independently of editor/key-repeat redraws, smooth height with hysteresis, repaint only changed glyph/color, and avoid false amplitude dips between buffered PCM arrivals.
- Measure actual cursor-row clears during silent holds and optionally capture timed native terminal writes for motion review, rather than relying only on static cursor frames.
- Match directly observed Claude Code cursor updates: use a shared 16 Hz presentation cadence and narrow eligible fullscreen cursor-only frames to a single-cell write, preserving native rendering for text changes, resizes, unknown sequences, and regular mode.
- Strengthen the actual-Pi smoke to require zero cursor-row clears and reference-paced cell updates, and verify resize recovery during a hold. Colored Deepgram, monochrome Groq and reduced-motion Deepgram checks passed.
- Add a native OMP adapter with realtime provisional text, held-Space input, and end/mid-draft audio cursor rendering. Reuse the shared providers and audio core without importing Pi-only rendering APIs or changing global OMP settings.
- Add an interactive Pi / OMP / Both installer, explicit `--host` selection for scripts, custom agent roots, and all-destination conflict preflight. Preserve existing private credentials and provider selection.
- Add dual-host live smoke scenarios with an actual OMP editor observer, native-Space conflict checks, voice-off behavior, and `/new` reinstallation. Keep Pi's renderer-specific assertions separate from OMP's native surface.

## 0.1.0 — 2026-11-03

- Pi-only held-Space microphone dictation with Groq Whisper and Deepgram prerecorded transcription.
- Ordinary Space taps, Kitty key-release handling, legacy repeat-gap handling, and Ctrl+Shift+R recording toggle.
- Cursor insertion without auto-send; cancellation on Escape, focus loss, submission, and session shutdown.
- In-memory ffmpeg recording, bounded duration, request timeout, and no implicit provider fallback.
- Private key-file installation and persisted provider selection.

Verified with Pi 1.2.0 on Linux: microphone capture, live Groq transcription, real Pi legacy/Kitty input smokes, and 47 regression tests plus TypeScript checking. Deepgram transport is covered by request/response tests; a live check requires a Deepgram key. OMP is not supported in this release.
