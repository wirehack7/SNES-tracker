# SNES Tracker

A tracker for Super Nintendo music that runs in the browser — on desktop with a keyboard and on phones with
touch. The sound comes from an emulation of the SPC700's S-DSP: eight voices of BRR samples at 32 kHz with
Gaussian interpolation, ADSR and GAIN envelopes, the noise generator, pitch modulation and the hardware echo
with its 8-tap FIR filter. What you hear are the same DSP register writes a sound driver makes on the console,
and the SPC export ships them with a small SPC700 driver.

**Play it:** <https://snes.chiptrackr.com/>

**Manual:** [docs/MANUAL.md](docs/MANUAL.md), also on the site as [manual.html](https://snes.chiptrackr.com/manual.html).

## Features

- 8 voices, each able to play any instrument, as on the hardware
- Pattern editor with order list, 32 instruments, blocks, undo/redo and 256 patterns
- 63 BRR samples: import audio (WAV, MP3, OGG…), set loop points, normalize, reverse, halve the rate, retune
- Sample creation built in: a waveform synth (square with duty, saw, triangle, sine, 16 harmonics, free drawing)
  and a drum synth (kick, snare, hi-hat, tom, clap, cymbal)
- Instruments: sample, volume, pan, transpose, finetune, ADSR or GAIN envelopes with a measured envelope graph,
  release fade, and the echo, noise and pitch-modulation switches
- Hardware echo: delay, feedback, left/right volume, the eight FIR taps with presets, and an audio RAM meter that
  shows how samples and the echo buffer share the 64 KiB
- 16 effects: arpeggio, slides, portamento, vibrato, voice flags, noise clock, delay, pan, echo volume and
  feedback, volume slide, jump, break, cut, speed and tempo
- Oscilloscope per voice, click to mute
- Song library in the browser (save, open, search, rename, duplicate, delete), JSON import/export, ZIP backup of
  the library, automatic working-copy backup
- Exports: SPC (with its own SPC700 driver), WAV, MP3, MP4 video with scopes and the scrolling pattern, XM, and
  per-voice stems
- SPC import: the tracker's own SPC files open as the song again; any other SPC is transcribed into patterns by
  running its own driver on the emulated SPC700 and writing down the notes it plays
- SPC player: any SPC file plays with its own driver on a full SPC700 emulation (all 256 opcodes, timers, ports,
  IPL ROM), checked opcode by opcode against the SingleStepTests reference suite
- Super Famicom colours with the ABXY accents, light and dark mode, colour-coded pattern columns
- Responsive: desktop with side lists, tablet two-column, phone with views and an on-screen keypad
- On-screen piano (mouse, touch, glissando) and Web MIDI input from any connected keyboard
- Installable app (PWA): works offline after the first visit
- Interface in English and German (picked from the browser language, switchable in the toolbar)

## Exports

The SPC export is the hardware one: `src/export/stream.ts` captures the song as the DSP register writes the
player makes per tick, and `src/export/spc.ts` lays out audio RAM — driver at `$0200`, sample directory at
`$0400`, samples from `$0500`, the stream after them and the echo buffer at the top — and writes the SPC v0.30
file with its ID666 tags. The driver runs timer 0 at 8 kHz and replays the stream with the tracker's timing, so
an SPC player reproduces what the browser plays. The tests run that driver on a small SPC700 interpreter and
compare its DSP writes and their timing with the capture. After the SPC data the file carries the song as JSON
(a `STRK` chunk at `$10200`, which players skip), so `src/export/spcimport.ts` can open it again; from other SPC
files `src/spc/transcribe.ts` makes patterns: it runs the file's own driver on the emulated SPC700, records every
key-on (with the voice's sample, pitch, volume and envelope), key-off and volume change, fits a row grid to the
note timing (per 20-second stretch, counted from note to note so the driver's drift never adds up) and writes the
notes with the BRR samples they use.

`src/spc/cpu.ts` is the SPC700 and `src/spc/apu.ts` the audio unit around it (I/O registers, timers 0-2, IPL
ROM), so any SPC file plays on the same DSP. `tests/spc/cpu.test.ts` runs every opcode against cases from the
[SingleStepTests SPC700 suite](https://github.com/SingleStepTests/spc700) (MIT licence; picked by
`scripts/spc700-vectors.mjs`): registers, flags, memory and cycle counts must all match.

Stream format used by the driver:

| Byte | Meaning |
| --- | --- |
| `0x00`–`0x7F`, `vv` | write `vv` to DSP register `byte` |
| `0x80`, `lo`, `hi` | timer periods per tick (the tempo) |
| `0x81`–`0xFE` | wait `byte & 0x7F` ticks |
| `0xFF` | continue at the loop address |

The other exports: **WAV** (16-bit stereo, rendered by the emulator), **MP3** and **MP4** (mediabunny, the video
is 1280×720 with the eight scopes and the scrolling pattern), **XM** (FastTracker 2 module: BRR samples decoded
to 16 bits, the envelope measured on the emulated DSP, effects translated, and everything XM cannot play listed
afterwards) and **stems** (one WAV per voice in a ZIP).

## Development

```sh
npm install
npm run dev     # development server
npm test        # unit tests (DSP, BRR, player, SPC driver, exports, UI helpers)
npm run coverage   # the same with coverage
npm run build   # type check and production build into dist/
npm run smoke -- smoke-screenshots --chromium   # browser smoke test of the built site
```

[TESTING.md](TESTING.md) explains what the tests cover. CI runs the tests and the build on every pull request, plus the browser smoke test in Chromium, Firefox and
WebKit. Pushes to `main` are deployed to GitHub Pages at <https://snes.chiptrackr.com/>; the custom domain
is set in the repository's Pages settings (an Actions deploy ignores a `CNAME` file). The build uses relative
paths, so it runs at a domain root and under a sub-path alike.

### Layout

| Path | What is in it |
| --- | --- |
| `src/dsp/` | S-DSP emulation, BRR codec, Gaussian table |
| `src/tracker/` | song model, player and effects, samples, synths, audio RAM layout, library |
| `src/audio/` | AudioWorklet engine and client |
| `src/export/` | register stream, SPC export and import, WAV, MP3/MP4, XM, ZIP |
| `src/spc/` | SPC700 CPU, the audio unit (timers, ports, IPL ROM) that plays SPC files, and SPC transcription |
| `src/ui/`, `src/main.ts` | pattern editor, piano, scopes, the tracker UI |
| `src/i18n/` | interface translations |
| `docs/MANUAL.md` | the manual, rendered into `manual.html` at build time |
| `docs/images/` | the manual's screenshots; `npm run build && node scripts/manual-images.mjs` renders them again |

### Analytics

The repository contains no analytics. A deployment can add its own snippet at build time: the Pages workflow
passes the repository variable `TRACKING_CODE` (raw HTML, e.g. the `<script>` tags of your analytics service;
Settings > Secrets and variables > Actions > Variables) to the build, which puts it unchanged at the end of
`<head>` of every page (`src/analytics/plugin.ts`). Without it, as in local, dev and CI builds and forks, nothing
is added.

The tracker reports user actions as `snes-tracker:track` window events with `{ name, data }` as their detail
(`src/analytics/track.ts`): `play` (`mode`), `stop`, `export` (`format`), `import`, `sample-import`, `song-new`,
`song-demo`, `library` (`action`), `theme`, `language`, `piano`, `midi`, `about`, `pwa-install` and
`pwa-launch`. To forward them, add a listener to the snippet, for example for Umami:

```html
<script>
  addEventListener('snes-tracker:track', (e) => window.umami?.track(e.detail.name, e.detail.data));
</script>
```

The service worker only handles requests inside the site's own scope, so external analytics scripts are never
cached for offline use.

## Licence

MIT.
