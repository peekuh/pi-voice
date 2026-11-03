# pi-voice

Hold-Space dictation for the **Pi coding agent**, with **Deepgram realtime streaming** and an optional **Groq phrase-transcription** backend.

Deepgram is the default: microphone PCM is sent continuously over one WebSocket, interim text updates in place, and final results commit without duplication. Release flushes the server's final results. Groq instead uploads completed speech phrases. No local recognition model, LLM cleanup, spoken replies, or automatic submission.

**Pi only.** This package does not install into, modify, or claim compatibility with OMP.

## Requirements

- Pi 1.2.0 or newer; Node.js 22.19 or newer.
- `ffmpeg` on PATH and permission to use the microphone.
- A Groq or Deepgram API key and an internet connection.
- No other extension replacing Pi's editor or implementing voice input.

Verified on Linux with Pi 1.2.0 and Node 26.12.1. Linux recording uses the default PulseAudio/PipeWire source. The recorder also has macOS AVFoundation and Windows DirectShow argument handling, but those platforms have not been live-tested. Windows requires an explicit `capture.device`.

## Install this checkout

```sh
npm run install:local
```

The installer writes `~/.pi/agent/extensions/cloud-voice.ts`, importing this checkout by absolute path. Keep the checkout in place. Restart Pi or run `/reload`.

To import a labelled file containing both keys without putting them in shell history:

```sh
npm run install:local -- --keys-file /absolute/path/to/api-keys.txt
```

Use `Groq: ...` and `Deepgram: ...` on separate lines (`GROQ_API_KEY=...` and `DEEPGRAM_API_KEY=...` also work). The installer stores raw copies in `~/.config/pi-voice/groq.key` and `deepgram.key`, with mode `0600`, and references them from the config. The source file is left untouched. For a file containing only a raw Groq key, use `--groq-key-file` instead. An unrelated existing `cloud-voice.ts` is never overwritten.

Installing the extension requires no runtime npm dependencies: Pi provides its editor and keyboard APIs. To develop or run the checks:

```sh
npm ci --ignore-scripts
npm run check
```

## Dictate

1. Hold **Space** until the footer says `recording` (minimum 600 ms plus enough repeats to recognize the cadence).
2. Speak while holding. Space repeats do not move the cursor. Deepgram's interim transcript updates as speech arrives and may revise earlier words in the current hypothesis.
3. Release to finalize the stream. Wait for the footer to return to idle before reviewing the final text.
4. Review the text and press **Enter** yourself.

Space taps insert immediately. Initial candidate spaces are rolled back once a steady held-key cadence is recognized; only spaces still owned by that gesture can be removed. Detection does not assume that a terminal advertising Kitty support labels repeats or sends releases. Plain repeat bursts, Pi-split sub-millisecond callbacks, and batched spaces are handled. Explicit key-up events end the hold when supplied; otherwise a 250 ms repeat gap does. A late timer after an event-loop stall defers release so queued repeats can drain.

**Ctrl+Shift+R** toggles recording without a hold. **Escape** or **Ctrl+C** cancels capture and pending responses, removing only the owned interim hypothesis; finalized text remains. Focus loss, session replacement, and extension shutdown also cancel pending work. Another editing key clears the provisional preview before performing its normal action. Submitting the draft cancels pending transcription so it cannot appear in the next prompt. User edits are never replaced wholesale.

### Audio-reactive recording cursor

While recording, a colorful software cursor replaces the ordinary caret at the same insertion point. Its height follows the microphone's local PCM level: quiet input shows a short block and louder input grows toward a full-height block. A fast attack and short release keep it responsive without jitter. The color cycles smoothly while listening, with redraws capped at 24 frames per second.

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

### Live Pi smoke

```sh
python scripts/smoke-live.py                  # Deepgram realtime
python scripts/smoke-live.py --provider both  # Also exercise Groq phrase mode
```

This Linux-only smoke requires `pi`, `ffmpeg`, `pactl`, `paplay`, configured provider keys, and a running PulseAudio-compatible server. It consumes real API quota and downloads the public [Whisper JFK speech fixture](https://github.com/openai/whisper/blob/main/tests/jfk.flac).

It starts actual Pi PTYs with normal installed-extension discovery and records from an isolated PulseAudio/PipeWire null-sink monitor through the real ffmpeg recorder. It injects a held-Space cadence, batched/unlabelled input, explicit and missing key-up events, bracketed paste, and a 350 ms event-loop stall. It observes real editor text/cursor snapshots, rather than substituting a fake editor or recorder.

For Deepgram, a transport observer requires one live WebSocket, continuous PCM, server `is_final:false` hypotheses rendered before the first speech pause, zero prerecorded HTTP uploads, and `CloseStream` followed by clean server finalization. Final editor text must match the committed server segments without duplicated interims. A second live utterance verifies that Escape removes the owned provisional text and blocks late results.

Verified on Linux with Pi 1.2.0 / Node 26.12.1: 185 regression tests plus TypeScript checking, live Deepgram interim/final rendering, cancellation, and both-provider interaction smokes. These are real Pi sessions with injected terminal events, not physical desktop keyboard/window-manager tests; interception outside Pi remains environment-dependent. The smoke restores its temporary audio resources and does not change default input/output devices.

## Layout

```text
index.ts             Pi editor and slash-command integration
src/hold.ts          Space gesture and legacy repeat-gap detection
src/controller.ts    Recording/transcription ownership and cancellation
src/audio-meter.ts   PCM loudness envelope without retaining audio
src/cursor.ts        Audio-reactive software-cursor rendering
src/recorder.ts      ffmpeg capture and WAV encoding
src/providers.ts     Groq HTTPS transcription and shared credential resolution
src/stream.ts        Provider dispatch and Groq phrase queue/rate spacing
src/deepgram.ts      Realtime WebSocket, PCM delivery, and server finalization
src/transcript.ts    Owned interim span replacement and final commits
src/segmenter.ts     Energy-based speech boundaries, without a recognition model
src/credentials.ts   Labelled credential-file parsing
src/config.ts        Strict shared configuration and provider persistence
scripts/install.ts   Pi installation and private provider-key import
scripts/smoke-live.py Live Pi, PulseAudio, and realtime transport verification
```

MIT licensed.
