# pi-voice

Hold-Space dictation for **Pi and OMP**, with **Deepgram realtime streaming** and an optional **Groq phrase-transcription** backend.

Deepgram is the default: microphone PCM is sent continuously over one WebSocket, interim text updates in place, and final results commit without duplication. Release flushes the server's final results. Groq instead uploads completed speech phrases. No local recognition model, LLM cleanup, spoken replies, or automatic submission.

Separate native host adapters share the recording, transcription, held-key detection, configuration, and audio-meter code. OMP uses native provisional-text and cursor APIs; it does not load the Pi-specific fake-cursor/output adapter.

## Requirements

- Pi 1.2.0+ or OMP 18.8.4+, with the chosen CLI's supported runtime. Node.js 22.19+ runs the installer and development checks.
- `ffmpeg` on PATH and permission to use the microphone.
- A Groq or Deepgram API key and an internet connection.
- No other extension replacing the selected host's main editor or implementing competing voice input.

Verified on Linux with Pi 1.2.0 and OMP 18.8.4. Linux recording uses the default PulseAudio/PipeWire source. The recorder also has macOS AVFoundation and Windows DirectShow argument handling, but those platforms have not been live-tested. Windows requires an explicit `capture.device`.

## Install this checkout

```sh
npm run install:local
```

The interactive installer detects available CLIs and asks **Pi**, **OMP**, or **Both**. Scripts/noninteractive shells must select explicitly:

```sh
npm run install:local -- --host pi
npm run install:local -- --host omp
npm run install:local -- --host both
```

It writes only the selected entrypoints:

- `~/.pi/agent/extensions/cloud-voice.ts` imports `index.ts`.
- `~/.omp/agent/extensions/cloud-voice.ts` imports `omp.ts`.

Keep this checkout in place: imports are absolute. Restart Pi or run `/reload`; restart OMP. Both destinations are checked before writing anything, and unrelated existing extensions are never overwritten. For custom agent roots or OMP profiles, use `--pi-dir /path/to/pi-agent` and `--omp-dir /path/to/omp-profile/agent`.

OMP's native Space handler is disabled only on the extension-owned editor, even when `/voice off` is selected; ordinary spaces then type normally. No global OMP settings or keybinding files are modified. Main TUI sessions only: the adapter does not register interactive state in OMP subagents or headless/RPC sessions.

To import a labelled file containing both keys without putting them in shell history:

```sh
npm run install:local -- --host both --keys-file /absolute/path/to/api-keys.txt
```

Use `Groq: ...` and `Deepgram: ...` on separate lines (`GROQ_API_KEY=...` and `DEEPGRAM_API_KEY=...` also work). The installer stores raw copies in `~/.config/pi-voice/groq.key` and `deepgram.key`, with mode `0600`, and references them from the config. The source file is left untouched. For a file containing only a raw Groq key, use `--groq-key-file` instead. An unrelated existing `cloud-voice.ts` is never overwritten.

Installing the local entrypoints requires no runtime npm dependencies: each CLI supplies its own editor and keyboard APIs. Both hosts share `~/.config/pi-voice/config.json` and private credential files. Development checks use both hosts' type packages:

```sh
npm ci --ignore-scripts
npm run check
```

## Dictate

1. Hold **Space** until the recording cursor appears (minimum 600 ms plus enough repeats to recognize the cadence).
2. Speak while holding. Space repeats do not move the cursor. Deepgram's interim transcript updates as speech arrives and may revise earlier words in the current hypothesis.
3. Release to finalize the stream. Wait for the normal cursor to return before reviewing the final text.
4. Review the text and press **Enter** yourself.

Space taps insert immediately. Initial candidate spaces are rolled back once a steady held-key cadence is recognized; only spaces still owned by that gesture can be removed. Detection does not assume that a terminal advertising Kitty support labels repeats or sends releases. Plain repeat bursts, Pi-split sub-millisecond callbacks, and batched spaces are handled. Explicit key-up events end the hold when supplied; otherwise a 250 ms repeat gap does. A late timer after an event-loop stall defers release so queued repeats can drain.

**Ctrl+Shift+R** toggles recording without a hold. **Escape** or **Ctrl+C** cancels capture and pending responses, removing only the owned interim hypothesis; finalized text remains. Focus loss, session replacement, and extension shutdown also cancel pending work. Another editing key clears the provisional preview before performing its normal action. Submitting the draft cancels pending transcription so it cannot appear in the next prompt. User edits are never replaced wholesale.

Neither Pi nor OMP adds an automatic voice-status line beneath the session status bar. Use `/voice status` or `/voice doctor` when you want details; recording feedback stays at the cursor.

### Audio-reactive recording cursor

While recording, the cursor responds to microphone volume through a single 50 ms RMS envelope with square-root sensitivity. Height can change on each acoustic/display update (up to 60 Hz); it is no longer forced to climb or fall one block per 16 Hz tick. Linux capture requests mono 16 kHz audio in 512-byte fragments—measured at approximately 16 ms per callback instead of the previous 50 ms delivery.

Active sound uses a four-second saturated hue cycle. Silence turns the cursor neutral gray immediately while its height finishes decaying. The color clock runs independently at about 15 Hz and continues its phase through silence. This follows controlled-audio measurements of Claude Code 2.1.318 rather than assuming its color-update cadence was also its height-update cadence.

The envelope still tolerates 200 ms of missing audio delivery before treating a stalled input as stale. Actual silent PCM does not wait for that grace period. Ordinary key-repeat/editor redraws reuse the cached appearance; unchanged glyph/color frames do not repaint.

In Pi's default fullscreen mode, cursor-only animation updates the cursor cell rather than clearing and repainting the composer row. A scoped output adapter narrows only a recognized native frame whose surrounding row bytes are unchanged. Text edits, cursor movement, resizing, screen clears, unknown output formats, and regular-screen mode retain Pi's normal rendering path. No independent background terminal writes or installed-Pi patches are used.

The cursor becomes steady and muted while the stream finalizes, then the previous cursor mode is restored. Cancellation, focus loss, and extension shutdown also restore it. The indicator is rendering only: it does not insert characters, shift the draft, start another recording, or make extra transcription requests.

Terminal cells provide eight height steps rather than arbitrary pixel scaling. Set `cursor.reducedMotion` to `true` for a fixed recording indicator, or `cursor.enabled` to `false` to keep the ordinary caret. A nonempty `NO_COLOR` environment variable disables the rainbow but retains sound-responsive height.

## Commands

```text
/voice                       Show status
/voice doctor                Show credential presence, capture settings, and key protocol
/voice provider groq         Select Groq phrase HTTP transcription
/voice provider deepgram     Select Deepgram realtime WebSocket transcription
/voice on                    Enable held-Space recognition
/voice off                   Restore normal Space behavior
/voice cancel                Discard capture or cancel a request
```

Deepgram uses [its realtime Listen WebSocket](https://developers.deepgram.com/reference/speech-to-text/listen-streaming) with `interim_results=true`, raw mono 16 kHz PCM, and server endpointing. Each `is_final` result commits its segment; `speech_final` is not used as a substitute for segment finality. On release, `CloseStream` flushes pending audio and the client waits for final results, metadata, and a clean server close.

Groq uses its prerecorded HTTP API on speech segments: a 600 ms pause commits a phrase and uninterrupted speech splits at 12 seconds. Groq request starts are spaced at least 3.1 seconds apart for its published 20 RPM free-tier limit. It does not provide Deepgram-style interim captions. Provider/account limits still apply; there is no automatic fallback between the two.

## Configuration

Default: `~/.config/pi-voice/config.json`. Override with `PI_VOICE_CONFIG=/absolute/path/config.json`. Values are read at session startup; restart or `/reload` after editing them. Provider commands persist to the same file.

A minimal Groq setup:

```json
{
  "provider": "groq",
  "groq": {
    "apiKeyFile": "/absolute/path/to/private/groq.key"
  }
}
```

A Deepgram setup:

```json
{
  "provider": "deepgram",
  "deepgram": {
    "apiKeyFile": "/absolute/path/to/private/deepgram.key"
  }
}
```

API-key files must contain a single raw key. A nonempty `GROQ_API_KEY` or `DEEPGRAM_API_KEY` environment variable takes precedence over the configured file. The `apiKeyEnv` field can select another environment variable; file paths support `~/`. Use absolute paths to avoid dependence on the project directory. No literal credentials, shell commands, or custom API URLs are accepted in configuration.

All defaults (only override what you need):

```json
{
  "provider": "deepgram",
  "language": "en",
  "holdMs": 600,
  "releaseMs": 250,
  "maxSeconds": 120,
  "timeoutMs": 30000,
  "groq": {
    "model": "whisper-large-v3-turbo",
    "apiKeyEnv": "GROQ_API_KEY"
  },
  "deepgram": {
    "model": "nova-3",
    "apiKeyEnv": "DEEPGRAM_API_KEY"
  },
  "capture": {
    "ffmpegPath": "ffmpeg",
    "device": "default"
  },
  "cursor": {
    "enabled": true,
    "reducedMotion": false
  }
}
```

`language: "auto"` selects Deepgram's realtime `language=multi`; for Groq it omits the language hint. For explicit Groq hints use ISO 639-1 codes such as `en`; Deepgram accepts its supported language tags. Model/language availability remains provider-specific.

`maxSeconds` is bounded to 1–300 seconds. Hitting the duration or audio-buffer cap stops capture with an error, retaining finalized text and removing the owned interim preview. `timeoutMs` bounds Deepgram opening/finalization or each Groq request, not the entire live recording. There are no retries, provider switches, or local fallbacks.

## Privacy and permissions

- Audio is mono 16 kHz PCM in process memory; Groq phrases are wrapped as WAV. Normal dictation writes no audio files.
- Recording begins only after the hold threshold. There is no pre-recording buffer: wait for the recording indicator before speaking.
- Audio leaves your machine only for the selected provider's encrypted HTTPS/WSS transcription connection. Provider retention, pricing, and account limits apply.
- No keyboard-device access, global hotkey daemon, clipboard injection, root permission, or OS input-group changes.
- API errors do not include response bodies or keys. The extension does not log audio or transcripts.
- `capture.ffmpegPath` executes a local program with your privileges. Keep the configuration trusted.

## Verification

```sh
npm run check
```

The regression suite covers realtime interim/final transitions, owned preview replacement, cursor and suffix preservation, cancellation, WebSocket finalization, audio bounds, held-key cadence, provider errors, and private credential import.

### Live Pi and OMP smoke

```sh
python scripts/smoke-live.py --host pi --provider both
python scripts/smoke-live.py --host omp --provider both
python scripts/smoke-live.py --host omp --provider deepgram --reduced-motion
env -u NO_COLOR python scripts/smoke-live.py --host omp --capture /tmp/pi-voice-cursor-frames
```

This Linux-only smoke requires the selected `pi` or `omp` binary, `ffmpeg`, `pactl`, `paplay`, configured provider keys, and a running PulseAudio-compatible server. It consumes real API quota and downloads the public [Whisper JFK speech fixture](https://github.com/openai/whisper/blob/main/tests/jfk.flac).

It starts actual CLI PTYs with normal installed-extension discovery and records from an isolated PulseAudio/PipeWire null-sink monitor through the real ffmpeg recorder. It injects a held-Space cadence, batched/unlabelled input, explicit and missing key-up events, bracketed paste, and a 350 ms event-loop stall. It observes real editor text/cursor snapshots, rather than substituting a fake editor or recorder. Before installation, `--extension ./omp.ts` (or `./index.ts`) loads only that adapter plus the observer in the temporary session.

The OMP run keeps native `stt.enabled` true in a temporary overlay, verifies that only the extension-owned native Space handler is disabled, checks `/voice off` cannot fall back to local STT, and starts a new session with `/new` before dictating again. It uses native volatile-text APIs and restores input/cursor behavior without modifying OMP's global settings.

For Deepgram, a transport observer requires one live WebSocket, continuous PCM, server `is_final:false` hypotheses rendered before the first speech pause, zero prerecorded HTTP uploads, and `CloseStream` followed by clean server finalization. Final editor text must match the committed server segments without duplicated interims. A second live utterance verifies that Escape removes the owned provisional text and blocks late results.

The cursor checks capture actual editor-render output and native-cursor visibility. They require a small neutral-gray cursor in silence, taller levels with the measured active-color saturation during speech, a steady finalizing indicator, and restoration after release/Escape. `--reduced-motion` verifies fixed height/color; `NO_COLOR` verifies the monochrome path. `--capture` saves public-fixture ANSI cursor frames without storing credentials or microphone recordings.

`--capture` additionally writes timestamped native terminal-output JSONL for motion replay; this preserves actual update timing instead of judging smoothness from still frames alone.

The Pi fullscreen smoke requires **zero composer-row erases and zero cursor-only animation paints during settled silence**, then verifies reactive speech updates and resize recovery. OMP uses its own component renderer; its smoke checks the resulting cursor, display width, resize behavior, and restored native cursor rather than assuming Pi's output-frame format.

Verified on Linux with Pi 1.2.0 and OMP 18.8.4: 246 regression tests plus TypeScript checking, live realtime transcription and cancellation in both hosts, and controlled-volume cursor captures. These are real CLI sessions with injected terminal events, not physical desktop keyboard/window-manager tests; interception outside the CLI remains environment-dependent. The smoke restores its temporary audio resources and does not change default input/output devices.

### Controlled-volume reference check

The same 440 Hz PCM tone sequence was played through isolated PulseAudio monitors into actual Claude Code, Pi, and OMP sessions. Steady-state height measurements:

| Sine amplitude | Claude Code 2.1.318 | Pi voice | OMP voice |
| --- | ---: | ---: | ---: |
| −50 dBFS | 3 | 3 | 3 |
| −35 dBFS | 7 | 7 | 7 |
| −20 dBFS | 8 | 8 | 8 |
| Silence | 1, gray | 1, gray | 1, gray |

The fitted response reaches full height in roughly 150 ms on the strong step and returns to minimum in roughly 100 ms after silent PCM. Claude's observed updates showed similar rapid, non-uniform transitions. The four-second hue period and fixed active RGB bounds (82–224) were measured directly. This is a fit to observable behavior, not a claim about Claude's internal implementation or a guarantee of identical perception on every terminal.

## Layout

```text
index.ts             Pi editor and slash-command integration
omp.ts               Native OMP editor, volatile transcript and cursor adapter
src/omp-cursor.ts    Native OMP mid-draft cursor painting
src/cursor-style.ts  Host-independent cursor appearance
src/hold.ts          Space gesture and legacy repeat-gap detection
src/controller.ts    Recording/transcription ownership and cancellation
src/audio-meter.ts   PCM loudness envelope without retaining audio
src/cursor.ts        Audio-reactive software-cursor rendering
src/cursor-animation.ts Cached smoothing, height hysteresis and presentation clock
src/cursor-output.ts Narrow cursor-only native frames without row erasure
src/recorder.ts      ffmpeg capture and WAV encoding
src/providers.ts     Groq HTTPS transcription and shared credential resolution
src/stream.ts        Provider dispatch and Groq phrase queue/rate spacing
src/deepgram.ts      Realtime WebSocket, PCM delivery, and server finalization
src/transcript.ts    Owned interim span replacement and final commits
src/segmenter.ts     Energy-based speech boundaries, without a recognition model
src/credentials.ts   Labelled credential-file parsing
src/config.ts        Strict shared configuration and provider persistence
scripts/install.ts   Host-specific entrypoints and private provider-key import
scripts/install-host.ts Interactive host detection and selection
scripts/smoke-live.py Real Pi/OMP, PulseAudio, and live-provider verification
scripts/smoke-observer.ts Runtime/terminal evidence collector
```

MIT licensed.
