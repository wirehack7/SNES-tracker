# Testing

The tracker is tested on two levels. **Unit tests** (Vitest, in Node) check the sound engine, the song model and
every export against the hardware rules, down to running the exported SPC driver on an SPC700 interpreter.
**Browser smoke tests** (Playwright) load the built site in Chromium, Firefox and WebKit and use it the way a
person would: on a desktop, a tablet and a phone, with mouse, keyboard and touch. CI runs both on every pull
request; nothing is deployed unless both pass.

```sh
npm test                 # unit tests, about 10 s
npm run coverage         # unit tests with coverage: text table, and coverage/index.html
npm run build            # type check and production build into dist/
npm run smoke -- smoke-screenshots --chromium   # browser smoke test of dist/ (also --firefox, --webkit)
```

## Unit tests

180 tests in 16 files under `tests/`.

| File | Tests | What it proves |
| --- | ---: | --- |
| `dsp/dsp.test.ts` | 14 | S-DSP: KON timing, ENVX/OUTX, ADSR attack to sustain, KOFF fade, ENDX, pitch, panning, FLG, noise, pitch modulation, echo delay and feedback, eight independent voices, muting |
| `dsp/brr.test.ts` | 10 | BRR decoding as the hardware does it (filters, shift clamp, loop and end flags), encoding, and the Gaussian table's shape and sums |
| `tracker/player.test.ts` | 24 | Tick timing at any BPM, note pitch, instrument registers, all 16 effects, audio RAM layout |
| `tracker/sample.test.ts` | 25 | Base64 (also without `atob`/`btoa`, as in the audio worklet), audio import, loop points, the waveform and drum synths, sample operations |
| `tracker/editor.test.ts` | 7 | Keys to notes, cursor wrapping, hex entry and ranges, note off, row insert/delete |
| `tracker/history.test.ts` | 8 | Undo/redo and block copy, paste and transpose |
| `tracker/library.test.ts` | 11 | Song library (save, rename, duplicate, delete, search) and the ZIP backup |
| `tracker/input.test.ts` | 7 | MIDI note mapping and the on-screen piano's layout |
| `export/spc.test.ts` | 14 | Register stream capture, SPC file layout and ID666 tags, and **the exported driver run on an SPC700 interpreter** (`export/spc700.ts`): its DSP writes and their timing match the capture |
| `export/xm.test.ts` | 16 | XM tuning, envelopes measured on the DSP, effect translation and warnings, the file layout, samples that decode back to the BRR audio |
| `export/wav.test.ts` | 12 | WAV files, offline rendering (loops, sample rates, limits), stems that add up to the mix, the engine, the song format |
| `ui/scope.test.ts` | 5 | Scope traces taken from the worklet's buffer |
| `pwa/pwa.test.ts` | 8 | The service worker caches the whole build; the manifest makes an installable app |
| `docs/manual.test.ts` | 8 | The manual documents every effect, button, tab and view; its links and images exist |
| `i18n/i18n.test.ts` | 7 | Placeholders, English fallback, the browser language picks the locale, every key in the markup exists |
| `analytics/analytics.test.ts` | 4 | The tracking snippet goes into the live build only |

## Coverage

Measured with V8 over `src/` (`npm run coverage`):

| Area | Lines | Branches | Threshold (lines / branches) |
| --- | ---: | ---: | --- |
| `src/dsp` — S-DSP, BRR, Gaussian table | 98 % | 89 % | 95 % / 85 % |
| `src/tracker` — song, player, samples, synths, library | 92 % | 88 % | 85 % / 80 % |
| `src/export` — SPC, stream, WAV, XM, ZIP | 98 % | 88 % | 90 % / 80 % |
| `src/audio/engine.ts` | 87 % | 63 % | — |
| everything in `src/` | 49 % | 42 % | — |

The thresholds in `vite.config.ts` fail CI when the engine's coverage drops. The total is lower on purpose: the
other half of `src/` is the interface (`main.ts`, the audio worklet and its client, the MP3/MP4 encoder in
`export/video.ts`, the About dialog), which needs a real browser. The smoke tests below cover it instead, and
Vitest cannot measure them.

What the numbers do not show: the hardware behaviour is pinned down by comparisons with known values, not
just executed. Examples are the Gaussian table, the KON delay, BRR filter results, the SPC driver's timing
measured in timer periods, and the XM samples decoded back bit for bit.

## Browser smoke tests

`scripts/smoke.mjs` serves `dist/`, opens it in one browser engine and runs these checks:

- **On every layout** (desktop, tablet, phone portrait, phone landscape):
  - It loads with no errors and no sideways scrolling.
  - Play starts and Stop stops.
  - The play cursor moves.
  - **Real audio reaches the output.** An analyser taps the speakers.
  - The scope traces stay centred.
  - The piano keys keep their size.
- **On phones:**
  - The bottom bar switches views.
  - The piano and the keypad enter notes.
  - The scopes stay above their columns on high-density screens.
- **Editing:**
  - Keyboard note entry survives a reload.
  - Undo and redo work.
  - Block select, copy, paste and transpose work.
  - The instrument envelope editor works.
- **Song library:** save, rename, duplicate, delete and back up songs.
- **Samples:** importing audio and the synths create samples, and those samples end up in the SPC file.
- **Exports:**
  - Each export downloads a valid file: SPC, WAV, MP3, XM, JSON and the stem ZIP.
  - MP4 either downloads, or a clear message appears where WebCodecs are missing.
- **Interface:**
  - The theme switches between auto, light and dark.
  - The About dialog keeps its keys away from the tracker.
  - English and German both fit a phone.
- **App:** the PWA works offline after the first visit (Chromium), and the manual loads with its images.

CI runs the smoke test in all three engines in Playwright's container image, and keeps the screenshots as a
build artifact. Some checks need features only one engine has in automation (audio output analysis, service
workers), so they run in Chromium only, and the script says so.

## Adding tests

- **A DSP or player change:** add a unit test that compares against a value from the hardware documentation or
  a measured value, not one copied from the current output.
- **A change to the SPC driver** (the hand-assembled bytes in `src/export/spc.ts`): run
  `tests/export/spc.test.ts`. The interpreter in `tests/export/spc700.ts` implements only the opcodes the
  driver uses, so add any new opcode there.
- **A UI change:** add a step to `scripts/smoke.mjs`, and run it in Chromium locally. CI runs Firefox and WebKit.
