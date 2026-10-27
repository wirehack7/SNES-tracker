# Roadmap

A Super Nintendo tracker for desktop and mobile browsers. Finished items are ticked; what is open is what the
next pull requests pick up.

## Phase 1 – Foundation
- [x] Project setup (Vite + TypeScript, Vitest), CI for tests, build and browser smoke test
- [x] S-DSP emulation at 32 kHz
  - [x] BRR decoding, bit exact, with the loop and end flags
  - [x] Gaussian interpolation (the hardware's 512-entry table)
  - [x] ADSR and GAIN envelopes from the counter rate table, key on/off with the five-sample delay
  - [x] Noise generator, pitch modulation, ENDX, per-voice mute
  - [x] Echo: FIR filter, feedback, ESA/EDL latching, the FLG bits
- [x] Song model (patterns, order list, instruments, samples, echo) and player with 16 effects
- [x] Audio RAM layout (directory, samples, echo buffer) with an overlap warning
- [x] Pattern editor in Super Famicom colours with dark mode
- [x] Keyboard and touch input (on-screen keypad for phones), piano and Web MIDI
- [x] Playback through an AudioWorklet, oscilloscope per voice
- [x] Save and load (browser storage, JSON file), song library with ZIP backup
- [x] Sample management: import, loop points, normalize, reverse, halve, retune
- [x] Sample creation: waveform synth and drum synth
- [x] Exports: SPC, WAV, MP3, MP4 video, XM, stems
- [x] Deployment to GitHub Pages

## Phase 2 – Depth
- [ ] Instrument envelope presets and a copy/paste bank shared across songs
- [ ] Sample editor: trimming, fades, a loop-crossfade for clean loops
- [ ] Per-pattern length and voice names
- [ ] More effects: retrigger, tremolo, fine slides, global volume slide
- [ ] Undo for the instrument and sample panels, not just the pattern

## Phase 3 – Hardware and interchange
- [ ] Import SPC files (read the DSP state and samples of an existing song)
- [ ] Import IT and XM modules as a starting point
- [ ] An SNES ROM export that plays the song on hardware and emulators
- [ ] A C/asm driver package for use in homebrew games
- [ ] MSU-1 style streaming as an alternative for long tracks

## Phase 4 – Polish
- [ ] More interface languages
- [ ] A guided first-run tour
- [ ] Shareable song links
