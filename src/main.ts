import './style.css';
import { AudioClient } from './audio/client';
import { DSP_RATE, VOICE_COUNT } from './dsp/dsp';
import { demoSong } from './tracker/demo';
import { RenderOptions, encodeWav, renderSong, renderStems } from './export/wav';
import { buildSpc } from './export/spc';
import { encodeXm, measureEnvelope } from './export/xm';
import { unzip, zip } from './export/zip';
import { MidiInput, MidiStatus, midiToNote } from './input/midi';
import { C4, NOTE_COUNT, noteName } from './tracker/notes';
import { SongLibrary, SongMeta, copySounds, fileName, openStore, uniqueNames } from './tracker/library';
import { track } from './analytics/track';
import { openAbout } from './ui/about';
import { pianoKeys, pianoOctaves, pianoWhites } from './ui/piano';
import { scopeTrace } from './ui/scope';
import { Block, clearBlock, contains, copyBlock, normalize, pasteBlock, transposeBlock } from './tracker/block';
import { History } from './tracker/history';
import { layoutAram } from './tracker/aram';
import {
  SAMPLE_COUNT,
  Sample,
  decodeSample,
  sampleBlocks,
  sampleBytes,
  sampleFromAudio,
  setLoop,
} from './tracker/sample';
import {
  CYCLE_LENGTHS,
  DRUM_KINDS,
  DrumKind,
  DrumParams,
  WAVE_SHAPES,
  WaveParams,
  WaveShape,
  defaultDrum,
  defaultWaveParams,
  drumSample,
  halveSample,
  normalizeSample,
  retuneSample,
  reverseSample,
  waveCycle,
  waveSample,
} from './tracker/synth';
import {
  CHANNEL_COUNT,
  FIR_PRESETS,
  INSTRUMENT_COUNT,
  Instrument,
  MAX_BPM,
  MAX_ROWS,
  MIN_BPM,
  NOTE_OFF,
  Song,
  clonePattern,
  createSong,
  deleteSample,
  emptyPattern,
  parseSong,
} from './tracker/song';
import {
  Cursor,
  FIELDS,
  MAX_OCTAVE,
  MIN_OCTAVE,
  clearField,
  deleteRow,
  enterDigit,
  enterNote,
  fieldGroup,
  formatCell,
  insertRow,
  jumpChannel,
  moveCursor,
  noteFromKey,
  resizePattern,
} from './ui/editor';
import { LOCALES, MessageKey, getLocale, matchLocale, onLocaleChange, setLocale, t, translateDom } from './i18n';

const STORAGE_KEY = 'snes-tracker.song';
const THEME_KEY = 'snes-tracker.theme';
const VOLUME_KEY = 'snes-tracker.volume';
const PIANO_KEY = 'snes-tracker.piano';
const MIDI_KEY = 'snes-tracker.midi';
const LANG_KEY = 'snes-tracker.lang';
const REC_KEY = 'snes-tracker.rec';
/** Which library entry the working copy belongs to, and whether it has unsaved changes. */
const SESSION_KEY = 'snes-tracker.session';
const DEFAULT_VOLUME = 60;

// ------------------------------------------------------------------ storage

function loadStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable (private mode) or full */
  }
}

function initialSong(): Song | null {
  const raw = loadStored(STORAGE_KEY);
  if (raw) {
    try {
      return parseSong(JSON.parse(raw));
    } catch {
      /* fall through to the demo */
    }
  }
  return null;
}

function initialSession(): { id: string | null; dirty: boolean } | null {
  try {
    const s = JSON.parse(loadStored(SESSION_KEY) ?? 'null');
    return s && typeof s === 'object' ? { id: typeof s.id === 'string' ? s.id : null, dirty: !!s.dirty } : null;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------- state

const restored = initialSong();
let song = restored ?? demoSong();
const session = initialSession();
/** Library entry of the working copy; null when it is not in the library. */
let songId = restored ? (session?.id ?? null) : null;
/** The working copy differs from its library entry (or is not in the library and has been edited). */
let dirty = restored ? (session?.dirty ?? false) : false;
let order = 0;
let cursor: Cursor = { row: 0, ch: 0, field: 0 };
let octave = 4;
let step = 1;
let instrument = 0;
let playing = false;
let playPos = { order: -1, row: -1 };
let follow = true;
let pianoVisible = loadStored(PIANO_KEY) !== 'off';
/** Record mode: off means notes are only played, nothing is edited. */
let rec = loadStored(REC_KEY) !== 'off';
let pianoState = '';
const muted: boolean[] = Array(CHANNEL_COUNT).fill(false);
type Tab = 'inst' | 'smpl' | 'song' | 'file' | 'help';
let tab: Tab = 'inst';
let instIndex = 0;
let sampleIndex = 0;
let waveParams: WaveParams = defaultWaveParams();
let drumParams: DrumParams = defaultDrum('kick');
let importRate = 16000;

const audio = new AudioClient();
audio.setSong(song);

let saveTimer = 0;
/** Keeps the working copy in localStorage, so a reload or a crash loses nothing. */
function persist(now = false) {
  clearTimeout(saveTimer);
  const write = () => {
    store(STORAGE_KEY, JSON.stringify(song));
    store(SESSION_KEY, JSON.stringify({ id: songId, dirty }));
  };
  if (now) write();
  else saveTimer = window.setTimeout(write, 400);
}

// Undo history: edits within half a second become one step.
const history = new History(JSON.stringify(song));
let historyTimer = 0;
function commitHistory() {
  clearTimeout(historyTimer);
  historyTimer = 0;
  history.commit(JSON.stringify(song));
  updateUndoButtons();
}

function changed(structure = false) {
  audio.setSong(song);
  setDirty(true);
  persist();
  clearTimeout(historyTimer);
  historyTimer = window.setTimeout(commitHistory, 500);
  updateUndoButtons();
  if (structure) renderAll();
}

function updateUndoButtons() {
  const undoable = history.canUndo || historyTimer !== 0;
  for (const id of ['undo', 'redo'])
    document.getElementById(id)?.toggleAttribute('disabled', id === 'undo' ? !undoable : !history.canRedo);
}

/** Step back (or forward) in the history; the cursor and order stay where they are. */
function undoRedo(redo: boolean) {
  if (historyTimer) commitHistory();
  const snapshot = redo ? history.redo() : history.undo();
  if (snapshot === null) return;
  song = parseSong(JSON.parse(snapshot));
  order = Math.min(order, song.order.length - 1);
  if (cursor.row >= pattern().rows.length) cursor = { ...cursor, row: 0 };
  selection = null;
  audio.setSong(song);
  setDirty(true);
  persist();
  updateUndoButtons();
  renderAll();
  toast(t(redo ? 'edit.redone' : 'edit.undone'));
}

const pattern = () => song.patterns[song.order[order]] ?? song.patterns[0];
const hex2 = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
const insLabel = (i: number) => hex2(i + 1);

// ---------------------------------------------------------------------- DOM

const app = document.getElementById('app')!;
app.dataset.view = 'pattern';
setLocale(loadStored(LANG_KEY) ?? matchLocale(navigator.languages ?? [navigator.language]));
document.documentElement.lang = getLocale();
/** A 24x24 transport glyph; drawn as SVG so it looks the same on every platform, unlike ▶ ■ ● ⟳. */
const icon = (shape: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${shape}</svg>`;
const stepper = (id: string, label: MessageKey, title: MessageKey) =>
  `<span class="field" data-i18n-title="${title}"><span data-i18n="${label}"></span> <span class="stepper"><button type="button" id="${id}-down" data-step-name="${title}" data-step-dir="down">‹</button><output id="${id}"></output><button type="button" id="${id}-up" data-step-name="${title}" data-step-dir="up">›</button></span></span>`;
app.innerHTML = `
  <header class="toolbar">
    <div class="brand"><span class="led" id="play-led" data-i18n-title="app.playing"></span><h1>SNES TRACKER<span>S-DSP · SPC700</span></h1></div>
    <div class="transport">
      <button type="button" class="pad-btn play" id="play-song" data-i18n-title="transport.playSong" data-i18n-aria-label="transport.playSongLabel">${icon('<path d="M8 5.5v13l10.5-6.5z"/>')}</button>
      <button type="button" class="pad-btn loop" id="play-pattern" data-i18n-title="transport.loopPattern" data-i18n-aria-label="transport.loopPatternLabel">${icon('<path d="M17.65 6.35A8 8 0 1 0 19.73 14h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4z"/>')}</button>
      <button type="button" class="pad-btn stop" id="stop" data-i18n-title="transport.stop" data-i18n-aria-label="transport.stop">${icon('<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/>')}</button>
      <button type="button" class="pad-btn rec" id="rec" data-i18n-title="transport.rec" data-i18n-aria-label="transport.recLabel">${icon('<circle cx="12" cy="12" r="5.5"/>')}</button>
    </div>
    <div class="fields">
      ${stepper('ord', 'field.ord', 'field.ordTitle')}
      <span class="field"><span data-i18n="field.pat"></span> <output id="pat"></output></span>
      ${stepper('oct', 'field.oct', 'field.octTitle')}
      ${stepper('ins', 'field.ins', 'field.insTitle')}
      ${stepper('stp', 'field.step', 'field.stepTitle')}
      ${stepper('spd', 'field.spd', 'field.spdTitle')}
      ${stepper('bpm', 'field.bpm', 'field.bpmTitle')}
      <span class="field" data-i18n-title="aram.title"><output class="badge" id="aram-badge"></output></span>
    </div>
    <div class="toolbar-end">
      <span class="undo-btns"><button class="pill-btn" id="undo" type="button" data-i18n-title="edit.undoTitle" data-i18n-aria-label="edit.undo" disabled>↶</button><button class="pill-btn" id="redo" type="button" data-i18n-title="edit.redoTitle" data-i18n-aria-label="edit.redo" disabled>↷</button></span>
      <button class="pill-btn" id="piano-toggle" type="button" data-i18n-title="piano.toggleTitle" data-i18n="piano.toggle"></button>
      <button class="pill-btn" id="midi" type="button"></button>
      <label class="field volume" data-i18n-title="volume.title"><span data-i18n="volume.label"></span> <input type="range" id="vol" min="0" max="100" step="1"><output id="vol-out"></output></label>
      <select class="pill-btn lang" id="lang" data-i18n-title="language.title" data-i18n-aria-label="language.title">${LOCALES.map((l) => `<option value="${l.code}" lang="${l.code}" title="${l.name}">${l.code.toUpperCase()}</option>`).join('')}</select>
      <button class="pill-btn" id="theme" type="button"></button>
    </div>
  </header>
  <div class="workspace">
    <aside class="sidebar left" data-i18n-aria-label="layout.lists">
      <section class="box">
        <h2 data-i18n="order.title"></h2>
        <div class="order-list" id="order-list"></div>
        <div class="mini-btns">
          <button type="button" id="o-dec" data-i18n-title="order.patDownTitle" data-i18n="order.patDown"></button>
          <button type="button" id="o-inc" data-i18n-title="order.patUpTitle" data-i18n="order.patUp"></button>
          <button type="button" id="o-ins" data-i18n-title="order.insertTitle" data-i18n="order.insert"></button>
          <button type="button" id="o-dup" data-i18n-title="order.duplicateTitle" data-i18n="order.duplicate"></button>
          <button type="button" id="o-del" data-i18n-title="order.deleteTitle" data-i18n="order.delete"></button>
        </div>
      </section>
      <section class="box grow">
        <h2 data-i18n="instList.title"></h2>
        <div class="inst-list" id="inst-list"></div>
      </section>
    </aside>
    <main class="editor" data-i18n-aria-label="layout.editor">
      <div class="chan-head" id="chan-head"></div>
      <div class="pattern" id="pattern" tabindex="0" role="grid" data-i18n-aria-label="layout.pattern"></div>
      <div class="piano" id="piano" data-i18n-aria-label="piano.label"></div>
      <div class="keypad" id="keypad"></div>
    </main>
    <aside class="sidebar right" data-i18n-aria-label="layout.editors">
      <div class="tabs" role="tablist">
        <button type="button" role="tab" data-tab="inst" data-i18n="tab.inst"></button>
        <button type="button" role="tab" data-tab="smpl" data-i18n="tab.smpl"></button>
        <button type="button" role="tab" data-tab="song" data-i18n="tab.song"></button>
        <button type="button" role="tab" data-tab="file" data-i18n="tab.file"></button>
        <button type="button" role="tab" data-tab="help" data-i18n="tab.help"></button>
      </div>
      <div class="panel" id="panel"></div>
    </aside>
  </div>
  <nav class="mobile-nav" data-i18n-aria-label="nav.views">
    <button type="button" data-view="pattern" data-i18n="nav.pattern"></button>
    <button type="button" data-view="lists" data-i18n="nav.lists"></button>
    <button type="button" data-view="edit" data-i18n="nav.edit"></button>
  </nav>
  <div class="toast" id="toast" role="status"></div>
`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const patternEl = $('pattern');

let toastTimer = 0;
function toast(text: string) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), 2600);
}

// ------------------------------------------------------------------- volume

const volumeInput = $('vol') as HTMLInputElement;

function applyVolume(percent: number) {
  const v = Math.max(0, Math.min(100, Math.round(percent)));
  volumeInput.value = String(v);
  $('vol-out').textContent = String(v).padStart(3, ' ');
  // Squared for a roughly perceptual curve.
  audio.setVolume((v / 100) ** 2 * 2);
  return v;
}

const storedVolume = Number(loadStored(VOLUME_KEY) ?? NaN);
applyVolume(Number.isFinite(storedVolume) ? storedVolume : DEFAULT_VOLUME);
volumeInput.addEventListener('input', () => store(VOLUME_KEY, String(applyVolume(Number(volumeInput.value)))));

// -------------------------------------------------------------------- theme

function applyTheme(theme: string | null) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  $('theme').textContent = t(theme === 'dark' ? 'theme.dark' : theme === 'light' ? 'theme.light' : 'theme.auto');
}
applyTheme(loadStored(THEME_KEY));
$('theme').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme ?? 'auto';
  const next = cur === 'auto' ? 'light' : cur === 'light' ? 'dark' : 'auto';
  store(THEME_KEY, next);
  applyTheme(next);
  track('theme', { theme: next });
});

// ----------------------------------------------------------------- language

/** Applies the current locale to the static shell; dynamic parts are re-rendered. */
function translateShell() {
  translateDom(app);
  app.querySelectorAll<HTMLElement>('[data-step-name]').forEach((b) => {
    const name = t(b.dataset.stepName as MessageKey);
    b.setAttribute('aria-label', t(b.dataset.stepDir === 'up' ? 'field.up' : 'field.down', { name }));
  });
  ($('lang') as HTMLSelectElement).value = getLocale();
}
translateShell();
$('lang').addEventListener('change', (e) => {
  const code = (e.target as HTMLSelectElement).value;
  store(LANG_KEY, code);
  setLocale(code);
  track('language', { lang: code });
});
onLocaleChange(() => {
  translateShell();
  renderMidi({ ...midi.status, error: undefined });
  applyTheme(document.documentElement.dataset.theme ?? null);
  renderAll();
});

/** Formats a number with the current locale's decimal separator. */
const num = (v: number, digits: number) =>
  v.toLocaleString(getLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });

const kib = (bytes: number) => (Math.abs(bytes) < 1024 ? `${bytes} B` : `${num(bytes / 1024, 1)} KiB`);

function escapeHtml(text: string) {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

// ------------------------------------------------------------------ header

function renderHeader() {
  $('ord').textContent = hex2(order);
  $('pat').textContent = hex2(song.order[order]);
  $('oct').textContent = String(octave);
  $('ins').textContent = insLabel(instrument);
  $('stp').textContent = String(step);
  $('spd').textContent = String(song.speed);
  $('bpm').textContent = String(song.bpm);
  renderAramBadge();
  renderOrderList();
  renderInstList();
  renderPiano();
}

function renderAramBadge() {
  const layout = layoutAram(song);
  const used = 0x10000 - Math.max(0, layout.free);
  const badge = $('aram-badge');
  badge.textContent = `ARAM ${Math.round((used / 0x10000) * 100)}%`;
  badge.classList.toggle('warn', layout.free < 0);
}

function renderOrderList() {
  const el = $('order-list');
  el.innerHTML = song.order
    .map(
      (p, i) =>
        `<button type="button" data-o="${i}" aria-current="${i === order}"><span class="pos">${hex2(i)}</span><span class="pat">${hex2(p)}</span></button>`,
    )
    .join('');
  (el.children[order] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
}

function renderInstList() {
  $('inst-list').innerHTML = song.instruments
    .map((ins, i) => {
      const editing = tab === 'inst' && instIndex === i ? ' class="editing"' : '';
      const empty = ins.sample < 0 && !ins.noise ? ' data-empty="true"' : '';
      return `<button type="button" data-i="${i}" aria-current="${i === instrument}"${editing}${empty}><span class="idx">${insLabel(i)}</span><span class="name">${escapeHtml(ins.name)}</span></button>`;
    })
    .join('');
}

function renderChannelHead() {
  $('chan-head').innerHTML =
    '<span class="num"></span>' +
    Array.from(
      { length: CHANNEL_COUNT },
      (_, i) => `<div class="chan${muted[i] ? ' muted' : ''}" data-ch="${i}">
        <div class="chan-title"><span>${t('channel.name', { n: i + 1 })}</span><button type="button" class="mute" aria-pressed="${muted[i]}" title="${t('channel.mute', { n: i + 1 })}">M</button></div>
        <canvas></canvas>
      </div>`,
    ).join('');
  scopeCanvases = [...$('chan-head').querySelectorAll('canvas')];
}

// ------------------------------------------------------------------ pattern

/** Empty fields are shown as dots, like in most trackers. */
const EMPTY_GLYPH = ['···', '·', '·', '·', '·', '·', '·', '·'];
/** The last digit of each column group gets a gap after it. */
const GROUP_END = [true, false, true, false, true, false, false, false];

function rowHtml(r: number) {
  const rows = pattern().rows;
  const cls = ['prow'];
  if (r % 16 === 0) cls.push('bar');
  else if (r % 4 === 0) cls.push('beat');
  if (r === cursor.row) cls.push('cursor-row');
  if (playing && playPos.row === r && playPos.order === order) cls.push('play-row');
  let html = `<div class="${cls.join(' ')}" data-row="${r}"><span class="num">${hex2(r)}</span>`;
  for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
    const cell = rows[r][ch];
    const groups = formatCell(cell);
    html += selection && contains(selection, r, ch) ? '<span class="cell sel">' : '<span class="cell">';
    for (let f = 0; f < FIELDS.length; f++) {
      const [g, d] = fieldGroup(f);
      const text = g === 0 || g === 3 ? groups[g] : groups[g][d];
      const empty = text.startsWith('-');
      let c = `f${g}`;
      if (GROUP_END[f]) c += ' ge';
      if (empty) c += ' empty';
      if (f === 0 && cell.note === NOTE_OFF) c += ' off';
      if (r === cursor.row && ch === cursor.ch && f === cursor.field) c += ' cursor';
      html += `<span class="${c}" data-ch="${ch}" data-f="${f}">${empty ? EMPTY_GLYPH[f] : text}</span>`;
    }
    html += '</span>';
  }
  return html + '</div>';
}

function renderPattern() {
  const rows = pattern().rows;
  let html = '';
  for (let r = 0; r < rows.length; r++) html += rowHtml(r);
  patternEl.innerHTML = html;
  scrollToRow(playing && follow && playPos.order === order ? playPos.row : cursor.row);
}

function updateRow(r: number) {
  const el = patternEl.children[r];
  if (el) el.outerHTML = rowHtml(r);
}

function scrollToRow(r: number) {
  const el = patternEl.children[r] as HTMLElement | undefined;
  if (!el) return;
  const top = el.offsetTop - patternEl.offsetTop;
  const target = top - patternEl.clientHeight / 2 + el.offsetHeight / 2;
  patternEl.scrollTop = Math.max(0, target);
}

/** Keeps the cursor's channel in view when the pattern scrolls sideways (phones). */
function scrollToChannel(ch: number) {
  const cell = patternEl.querySelector<HTMLElement>(`.prow [data-ch="${ch}"][data-f="0"]`)?.parentElement;
  if (!cell) return;
  const left = cell.offsetLeft;
  const right = left + cell.offsetWidth;
  if (left < patternEl.scrollLeft + 30) patternEl.scrollLeft = Math.max(0, left - 30);
  else if (right > patternEl.scrollLeft + patternEl.clientWidth) patternEl.scrollLeft = right - patternEl.clientWidth;
}

function setCursor(next: Cursor) {
  const prevRow = cursor.row;
  const prevCh = cursor.ch;
  cursor = next;
  updateRow(prevRow);
  if (next.row !== prevRow) updateRow(next.row);
  if (!(playing && follow)) scrollToRow(cursor.row);
  if (next.ch !== prevCh) scrollToChannel(next.ch);
  renderKeypad();
}

function setOrder(o: number) {
  order = Math.max(0, Math.min(song.order.length - 1, o));
  selection = null;
  if (cursor.row >= pattern().rows.length) cursor = { ...cursor, row: 0 };
  renderHeader();
  renderPattern();
  if (tab === 'song') renderPanel();
}

// Keep the channel header aligned when the pattern scrolls sideways on small screens.
patternEl.addEventListener('scroll', () => ($('chan-head').scrollLeft = patternEl.scrollLeft));

/** Row and channel of the cell under a pointer event, if any. */
function cellAt(e: PointerEvent) {
  const f = (e.target as HTMLElement).closest<HTMLElement>('[data-f]');
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-row]');
  if (!row) return null;
  return { row: Number(row.dataset.row), ch: f ? Number(f.dataset.ch) : cursor.ch, field: f ? Number(f.dataset.f) : cursor.field };
}

let dragAnchor: { row: number; ch: number } | null = null;
patternEl.addEventListener('pointerdown', (e) => {
  const at = cellAt(e);
  if (!at) return;
  if (e.shiftKey) {
    // Shift-click extends the block from the cursor.
    select({ r0: selection?.r0 ?? cursor.row, c0: selection?.c0 ?? cursor.ch, r1: at.row, c1: at.ch });
    setCursor(at);
    return;
  }
  if (selection) select(null);
  if (e.pointerType === 'mouse') dragAnchor = { row: at.row, ch: at.ch };
  setCursor(at);
});
patternEl.addEventListener('pointermove', (e) => {
  if (!dragAnchor || !(e.buttons & 1)) return;
  const at = cellAt(e);
  if (!at || (selection?.r1 === at.row && selection.c1 === at.ch)) return;
  if (!selection && at.row === dragAnchor.row && at.ch === dragAnchor.ch) return;
  select({ r0: dragAnchor.row, c0: dragAnchor.ch, r1: at.row, c1: at.ch });
  setCursor(at);
});
window.addEventListener('pointerup', () => (dragAnchor = null));

// ------------------------------------------------------------------- blocks

/** Selected block in the current pattern (corners as dragged, unsorted). */
let selection: Block | null = null;
let clipboard: ReturnType<typeof copyBlock> | null = null;

function select(next: Block | null) {
  selection = next;
  renderPattern();
}

/** The selection, or the cell under the cursor. */
function target(): Block {
  return selection ?? { r0: cursor.row, r1: cursor.row, c0: cursor.ch, c1: cursor.ch };
}

function extendSelection(dRow: number, dCh: number) {
  const rows = pattern().rows.length;
  const b = selection ?? { r0: cursor.row, r1: cursor.row, c0: cursor.ch, c1: cursor.ch };
  const r1 = Math.max(0, Math.min(rows - 1, b.r1 + dRow));
  const c1 = Math.max(0, Math.min(CHANNEL_COUNT - 1, b.c1 + dCh));
  selection = { ...b, r1, c1 };
  cursor = { ...cursor, row: r1, ch: c1 };
  renderPattern();
  renderKeypad();
}

function copySelection(cut: boolean) {
  const b = normalize(target(), pattern().rows.length);
  clipboard = copyBlock(pattern(), b);
  if (cut) {
    if (!rec) return;
    clearBlock(pattern(), b);
    changed();
    renderPattern();
  }
  toast(t(cut ? 'edit.cut' : 'edit.copied', { rows: b.r1 - b.r0 + 1, channels: b.c1 - b.c0 + 1 }));
}

function paste(mix: boolean) {
  if (!clipboard || !rec) return;
  const at = pasteBlock(pattern(), cursor.row, cursor.ch, clipboard, mix);
  if (!at) return;
  selection = at;
  changed();
  renderPattern();
}

function transposeSelection(semitones: number) {
  if (!rec) return;
  transposeBlock(pattern(), target(), semitones);
  changed();
  renderPattern();
}

$('undo').addEventListener('click', () => undoRedo(false));
$('redo').addEventListener('click', () => undoRedo(true));

// ------------------------------------------------------------------ editing

function editCell(fn: (c: ReturnType<typeof pattern>['rows'][0][0]) => void, advance = true) {
  if (!rec) return;
  const r = cursor.row;
  fn(pattern().rows[r][cursor.ch]);
  changed();
  updateRow(r);
  if (advance && step) setCursor(moveCursor(cursor, pattern().rows.length, step));
}

async function ensureAudio() {
  await audio.start();
}

function preview(ch: number, note: number, ins = instrument) {
  if (note < 0) return;
  void ensureAudio();
  audio.send({ type: 'preview', channel: ch, note, instrument: ins });
  highlightKey(note);
}

function release(ch: number) {
  if (!playing) audio.send({ type: 'release', channel: ch });
  highlightKey(-1);
}

/** Piano, MIDI and touch note input: enter on a note field, otherwise just play it. */
function playNote(note: number) {
  if (rec && FIELDS[cursor.field] === 'note') putNote(note);
  else preview(cursor.ch, note);
}

function putNote(note: number) {
  const ch = cursor.ch;
  if (!rec) {
    preview(ch, note);
    return;
  }
  editCell((c) => enterNote(c, note, instrument));
  if (note >= 0) preview(ch, note);
}

function putDigit(d: number) {
  editCell((c) => enterDigit(c, cursor.field, d));
}

function clearCurrent() {
  editCell((c) => clearField(c, cursor.field));
}

function togglePlay(loopPattern = false) {
  void ensureAudio();
  if (playing) {
    playing = false;
    audio.send({ type: 'stop' });
    track('stop');
  } else {
    playing = true;
    audio.send({ type: 'play', order, row: loopPattern ? cursor.row : 0, loopPattern });
    track('play', { mode: loopPattern ? 'pattern' : 'song' });
  }
  $('play-led').classList.toggle('on', playing);
  $('play-song').setAttribute('aria-pressed', String(playing && !loopPattern));
  $('play-pattern').setAttribute('aria-pressed', String(playing && loopPattern));
  renderPattern();
}

audio.onRow = (o, r) => {
  if (!playing) return;
  const prev = playPos;
  playPos = { order: o, row: r };
  if (follow && o !== order) {
    order = o;
    renderHeader();
    renderPattern();
    return;
  }
  if (prev.order === order) updateRow(prev.row);
  if (o === order) {
    updateRow(r);
    if (follow) scrollToRow(r);
  }
};

const noteKeysDown = new Map<string, number>();

const setOctave = (o: number) => (octave = Math.max(MIN_OCTAVE, Math.min(MAX_OCTAVE, o)));

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyS') {
    e.preventDefault();
    void saveToLibrary();
    return;
  }
  // An open dialog (About) keeps every shortcut, Escape included, out of the tracker.
  if (document.querySelector('dialog[open]')) return;
  if ((e.target as HTMLElement).closest('input, textarea, select, dialog')) return;
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const shortcuts: Record<string, () => void> = {
      KeyZ: () => undoRedo(e.shiftKey),
      KeyY: () => undoRedo(true),
      KeyC: () => copySelection(false),
      KeyX: () => copySelection(true),
      KeyV: () => paste(e.shiftKey),
      KeyA: () => select({ r0: 0, r1: pattern().rows.length - 1, c0: e.shiftKey ? cursor.ch : 0, c1: e.shiftKey ? cursor.ch : CHANNEL_COUNT - 1 }),
      ArrowUp: () => transposeSelection(e.shiftKey ? 12 : 1),
      ArrowDown: () => transposeSelection(e.shiftKey ? -12 : -1),
    };
    const run = shortcuts[e.code];
    if (run) {
      e.preventDefault();
      run();
    }
    return;
  }
  if (e.altKey) return;
  if (e.shiftKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'].includes(e.code)) {
    const d = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], PageUp: [-16, 0], PageDown: [16, 0] }[e.code]!;
    extendSelection(d[0], d[1]);
    e.preventDefault();
    return;
  }
  if (selection && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Tab'].includes(e.code))
    select(null);
  const rows = pattern().rows.length;
  const field = FIELDS[cursor.field];
  let handled = true;

  switch (e.code) {
    case 'ArrowUp':
      setCursor(moveCursor(cursor, rows, -1));
      break;
    case 'ArrowDown':
      setCursor(moveCursor(cursor, rows, 1));
      break;
    case 'ArrowLeft':
      setCursor(moveCursor(cursor, rows, 0, -1));
      break;
    case 'ArrowRight':
      setCursor(moveCursor(cursor, rows, 0, 1));
      break;
    case 'PageUp':
      setCursor({ ...cursor, row: Math.max(0, cursor.row - 16) });
      break;
    case 'PageDown':
      setCursor({ ...cursor, row: Math.min(rows - 1, cursor.row + 16) });
      break;
    case 'Home':
      setCursor({ ...cursor, row: 0 });
      break;
    case 'End':
      setCursor({ ...cursor, row: rows - 1 });
      break;
    case 'Tab':
      setCursor(jumpChannel(cursor, e.shiftKey ? -1 : 1));
      break;
    case 'Space':
      togglePlay(e.shiftKey);
      break;
    case 'Delete':
    case 'Backspace':
      if (selection && rec) {
        clearBlock(pattern(), selection);
        changed();
        renderPattern();
      } else clearCurrent();
      break;
    case 'Escape':
      setRec(!rec);
      break;
    case 'Insert':
      if (!rec) break;
      insertRow(pattern(), cursor.ch, cursor.row);
      changed();
      renderPattern();
      break;
    case 'BracketLeft':
    case 'NumpadSubtract':
      setOctave(octave - 1);
      renderHeader();
      break;
    case 'BracketRight':
    case 'NumpadAdd':
      setOctave(octave + 1);
      renderHeader();
      break;
    default:
      handled = false;
  }
  if (handled) {
    e.preventDefault();
    return;
  }
  if (e.repeat) return;

  // Without record mode the note keys play on every field.
  if (field === 'note' || !rec) {
    if (rec && (e.code === 'Digit1' || e.code === 'Backquote')) {
      putNote(NOTE_OFF);
      e.preventDefault();
      return;
    }
    const note = noteFromKey(e.code, octave);
    if (note !== null) {
      noteKeysDown.set(e.code, cursor.ch);
      putNote(note);
      e.preventDefault();
    }
    return;
  }
  const digit = /^[0-9a-f]$/i.test(e.key) ? parseInt(e.key, 16) : -1;
  if (digit >= 0) {
    putDigit(digit);
    e.preventDefault();
  }
});

document.addEventListener('keyup', (e) => {
  const ch = noteKeysDown.get(e.code);
  if (ch !== undefined) {
    noteKeysDown.delete(e.code);
    if (noteKeysDown.size === 0) release(ch);
  }
});

// ------------------------------------------------------------ touch keypad

const keypadEl = $('keypad');
function key(label: string, cls: string, data: string) {
  return `<button type="button" class="key ${cls}" ${data}>${label}</button>`;
}

function renderKeypad() {
  const isNote = FIELDS[cursor.field] === 'note';
  const kind = keypadEl.dataset.kind;
  const state = `${octave}/${pianoVisible}/${getLocale()}`;
  if (kind === (isNote ? 'note' : 'hex') && keypadEl.dataset.state === state) return;
  keypadEl.dataset.kind = isNote ? 'note' : 'hex';
  keypadEl.dataset.state = state;
  const navRow = `<div class="row">${key('◀', 'action', `data-act="prev" aria-label="${t('keypad.prev')}"`)}${key('▲', 'action', `data-act="up" aria-label="${t('keypad.up')}"`)}${key('▼', 'action', `data-act="down" aria-label="${t('keypad.down')}"`)}${key('▶', 'action', `data-act="next" aria-label="${t('keypad.next')}"`)}${key('↶', 'action', `data-act="undo" aria-label="${t('edit.undo')}"`)}${key('↷', 'action', `data-act="redo" aria-label="${t('edit.redo')}"`)}</div>`;
  if (isNote) {
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const keys = names.map((n, i) => key(n, n.includes('#') ? 'sharp' : '', `data-semi="${i}"`));
    const noteRows = pianoVisible
      ? ''
      : `<div class="row">${keys.slice(0, 6).join('')}</div><div class="row">${keys.slice(6).join('')}</div>`;
    keypadEl.innerHTML = `
      ${noteRows}
      <div class="row">
        ${key(t('keypad.octDown'), 'action', 'data-act="oct-"')}${key(t('keypad.octUp'), 'action', 'data-act="oct+"')}
        ${key(t('keypad.off'), 'action', 'data-act="off"')}${key(t('keypad.del'), 'red', 'data-act="del"')}
      </div>
      ${navRow}`;
  } else {
    const keys = Array.from({ length: 16 }, (_, i) => key(i.toString(16).toUpperCase(), '', `data-hex="${i}"`));
    keypadEl.innerHTML = `
      <div class="row">${keys.slice(0, 8).join('')}</div>
      <div class="row">${keys.slice(8).join('')}</div>
      <div class="row">${key(t('keypad.del'), 'red', 'data-act="del"')}</div>
      ${navRow}`;
  }
}

keypadEl.addEventListener('pointerdown', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
  if (!b) return;
  e.preventDefault();
  const rows = pattern().rows.length;
  if (b.dataset.semi) {
    const note = octave * 12 + Number(b.dataset.semi);
    if (note < NOTE_COUNT) putNote(note);
  } else if (b.dataset.hex) putDigit(Number(b.dataset.hex));
  else
    switch (b.dataset.act) {
      case 'oct-':
        setOctave(octave - 1);
        break;
      case 'oct+':
        setOctave(octave + 1);
        break;
      case 'off':
        putNote(NOTE_OFF);
        break;
      case 'del':
        clearCurrent();
        break;
      case 'prev':
        setCursor(moveCursor(cursor, rows, 0, -1));
        break;
      case 'next':
        setCursor(moveCursor(cursor, rows, 0, 1));
        break;
      case 'up':
        setCursor(moveCursor(cursor, rows, -1));
        break;
      case 'down':
        setCursor(moveCursor(cursor, rows, 1));
        break;
      case 'undo':
      case 'redo':
        undoRedo(b.dataset.act === 'redo');
        break;
    }
  renderHeader();
  renderKeypad();
});
keypadEl.addEventListener('pointerup', () => release(cursor.ch));
keypadEl.addEventListener('pointercancel', () => release(cursor.ch));

// --------------------------------------------------------------- rec mode

function setRec(on: boolean) {
  rec = on;
  store(REC_KEY, on ? 'on' : 'off');
  app.dataset.rec = on ? 'on' : 'off';
  $('rec').setAttribute('aria-pressed', String(on));
}
$('rec').addEventListener('click', () => setRec(!rec));
setRec(rec);

// ------------------------------------------------------------------- piano

function renderPiano() {
  const pianoEl = document.getElementById('piano');
  if (!pianoEl) return;
  pianoEl.hidden = !pianoVisible;
  $('piano-toggle').setAttribute('aria-pressed', String(pianoVisible));
  if (!pianoVisible) return;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const octaves = pianoOctaves(pianoEl.clientWidth || window.innerWidth, coarse ? 46 : 26);
  const state = `${octave}/${octaves}`;
  if (state === pianoState) return;
  pianoState = state;
  const keys = pianoKeys(octave, octaves);
  // A fixed slot count keeps the key size when the top octave has no closing C.
  pianoEl.style.setProperty('--whites', String(pianoWhites(octaves)));
  pianoEl.innerHTML = keys
    .map(
      (k) =>
        `<button type="button" tabindex="-1" class="pkey ${k.black ? 'black' : 'white'}" data-note="${k.note}" style="--i:${k.white}" aria-label="${k.label || k.note}">${k.label ? `<span>${k.label}</span>` : ''}</button>`,
    )
    .join('');
}

const pianoEl = $('piano');

function highlightKey(note: number) {
  for (const el of pianoEl.querySelectorAll('.pkey.down')) el.classList.remove('down');
  if (note >= 0) pianoEl.querySelector(`[data-note="${note}"]`)?.classList.add('down');
}

let pianoPointer: number | null = null;
let pianoNote = -1;
const keyAt = (x: number, y: number) =>
  document.elementFromPoint(x, y)?.closest<HTMLElement>('.pkey[data-note]') ?? null;

pianoEl.addEventListener('pointerdown', (e) => {
  const k = keyAt(e.clientX, e.clientY);
  if (!k) return;
  e.preventDefault();
  pianoPointer = e.pointerId;
  pianoEl.setPointerCapture(e.pointerId);
  pianoNote = Number(k.dataset.note);
  playNote(pianoNote);
});
// Gliding over the keys plays them without entering more notes.
pianoEl.addEventListener('pointermove', (e) => {
  if (e.pointerId !== pianoPointer) return;
  const k = keyAt(e.clientX, e.clientY);
  if (!k || Number(k.dataset.note) === pianoNote) return;
  pianoNote = Number(k.dataset.note);
  preview(cursor.ch, pianoNote);
});
const pianoUp = (e: PointerEvent) => {
  if (e.pointerId !== pianoPointer) return;
  pianoPointer = null;
  pianoNote = -1;
  release(cursor.ch);
};
pianoEl.addEventListener('pointerup', pianoUp);
pianoEl.addEventListener('pointercancel', pianoUp);

$('piano-toggle').addEventListener('click', () => {
  pianoVisible = !pianoVisible;
  store(PIANO_KEY, pianoVisible ? 'on' : 'off');
  track('piano', { on: pianoVisible });
  pianoState = '';
  renderPiano();
  renderKeypad();
});
window.addEventListener('resize', () => renderPiano());
renderPiano();

// -------------------------------------------------------------------- MIDI

const midi = new MidiInput();
const midiHeld = new Set<number>();

function midiTitle(s: MidiStatus) {
  if (!s.supported) return t('midi.unsupported');
  if (s.error) return s.error;
  if (!s.enabled) return t('midi.title');
  return t('midi.inputs', { inputs: s.inputs.join(', ') || t('midi.noInputs') });
}

function renderMidi(s: MidiStatus) {
  const b = $('midi');
  b.setAttribute('aria-pressed', String(s.enabled));
  b.textContent = s.enabled ? `MIDI ${s.inputs.length}` : 'MIDI';
  b.title = midiTitle(s);
  if (s.error) toast(s.supported ? s.error : t('midi.unsupported'));
}
midi.onStatus = renderMidi;
midi.onEvent = (e) => {
  const note = midiToNote(e.note);
  if (note === null) return;
  if (e.type === 'on') {
    midiHeld.add(note);
    playNote(note);
  } else {
    midiHeld.delete(note);
    if (midiHeld.size === 0) release(cursor.ch);
  }
};
$('midi').addEventListener('click', () => {
  if (midi.status.enabled) {
    midi.disable();
    store(MIDI_KEY, 'off');
    track('midi', { on: false });
  } else {
    void midi.enable().then((s) => {
      store(MIDI_KEY, s.enabled ? 'on' : 'off');
      track('midi', { on: s.enabled, inputs: s.inputs.length });
    });
  }
});
renderMidi({ ...midi.status, error: undefined });
if (loadStored(MIDI_KEY) === 'on' && midi.status.supported) void midi.enable();

// ---------------------------------------------------------------- toolbar

$('play-song').addEventListener('click', () => {
  if (playing) togglePlay();
  togglePlay(false);
});
$('play-pattern').addEventListener('click', () => {
  if (playing) togglePlay();
  togglePlay(true);
});
$('stop').addEventListener('click', () => playing && togglePlay());

const bump = (id: string, apply: (d: number) => void) => {
  for (const [dir, d] of [['down', -1], ['up', 1]] as const)
    $(`${id}-${dir}`).addEventListener('click', () => {
      apply(d);
      renderHeader();
      renderKeypad();
    });
};
bump('ord', (d) => setOrder(order + d));
bump('oct', (d) => setOctave(octave + d));
bump('ins', (d) => (instrument = (instrument + d + INSTRUMENT_COUNT) % INSTRUMENT_COUNT));
bump('stp', (d) => (step = Math.max(0, Math.min(16, step + d))));
bump('spd', (d) => {
  song.speed = Math.max(1, Math.min(31, song.speed + d));
  changed();
  if (tab === 'song') renderPanel();
});
bump('bpm', (d) => {
  song.bpm = Math.max(MIN_BPM, Math.min(MAX_BPM, song.bpm + d));
  changed();
  if (tab === 'song') renderPanel();
});

// ------------------------------------------------------------- side lists

$('order-list').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-o]');
  if (b) setOrder(Number(b.dataset.o));
});

$('inst-list').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
  if (!b) return;
  instrument = Number(b.dataset.i);
  instIndex = instrument;
  tab = 'inst';
  renderHeader();
  renderPanel();
});

const setPatternAt = (delta: number) => {
  const next = song.order[order] + delta;
  if (next < 0 || next > 255) return;
  while (next >= song.patterns.length) song.patterns.push(emptyPattern());
  song.order[order] = next;
  changed(true);
};
$('o-dec').addEventListener('click', () => setPatternAt(-1));
$('o-inc').addEventListener('click', () => setPatternAt(1));
$('o-ins').addEventListener('click', () => {
  song.order.splice(order + 1, 0, song.order[order]);
  order++;
  changed(true);
});
$('o-dup').addEventListener('click', () => {
  song.patterns.push(clonePattern(pattern()));
  song.order.splice(order + 1, 0, song.patterns.length - 1);
  order++;
  changed(true);
});
$('o-del').addEventListener('click', () => {
  if (song.order.length <= 1) return toast(t('order.lastPosition'));
  song.order.splice(order, 1);
  order = Math.min(order, song.order.length - 1);
  changed(true);
});

// ------------------------------------------------------------ mobile views

app.querySelectorAll<HTMLButtonElement>('.mobile-nav [data-view]').forEach((b) =>
  b.addEventListener('click', () => {
    app.dataset.view = b.dataset.view;
    renderMobileNav();
    if (b.dataset.view === 'pattern') scrollToRow(cursor.row);
  }),
);

function renderMobileNav() {
  app
    .querySelectorAll<HTMLButtonElement>('.mobile-nav [data-view]')
    .forEach((b) => b.setAttribute('aria-current', String(b.dataset.view === app.dataset.view)));
}

// ------------------------------------------------------------------- scopes

let scopeCanvases: HTMLCanvasElement[] = [];
$('chan-head').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.mute');
  if (!b) return;
  const ch = Number(b.closest<HTMLElement>('[data-ch]')!.dataset.ch);
  muted[ch] = !muted[ch];
  renderChannelHead();
  audio.send({ type: 'mute', muted: [...muted] });
});

let scopeData: Float32Array | null = null;
let scopeFrames = 0;
audio.onScope = (samples, frames) => {
  scopeData = samples;
  scopeFrames = frames;
};

function drawScopes() {
  const ink = getComputedStyle(document.documentElement).getPropertyValue('--scope-ink').trim();
  scopeCanvases.forEach((canvas, ch) => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    // Capped, so a layout glitch can never ask for a buffer the GPU refuses (a lost, blank canvas).
    const bw = Math.min(2048, Math.round(w * dpr));
    const bh = Math.min(512, Math.round(h * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    if (!w || !h) return;
    const g = canvas.getContext('2d')!;
    g.setTransform(bw / w, 0, 0, bh / h, 0, 0);
    g.clearRect(0, 0, w, h);
    g.strokeStyle = ink;
    g.lineWidth = 1.5;
    g.beginPath();
    if (!scopeData) {
      g.moveTo(0, h / 2);
      g.lineTo(w, h / 2);
    } else {
      const trace = scopeTrace(scopeData, scopeFrames, ch, 256);
      const n = trace.length;
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * w;
        const y = h / 2 - trace[i] * (h / 2 - 2);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
    }
    g.stroke();
  });
  requestAnimationFrame(drawScopes);
}
requestAnimationFrame(drawScopes);

// ------------------------------------------------------------------- panels

const panelEl = $('panel');
document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) =>
  b.addEventListener('click', () => {
    tab = b.dataset.tab as Tab;
    renderPanel();
  }),
);

function slider(id: string, label: string, value: number, min: number, max: number, shown: string = String(value)) {
  return `<label for="${id}">${label}</label><div class="range"><input type="range" id="${id}" min="${min}" max="${max}" value="${value}"><output>${shown}</output></div>`;
}

function check(id: string, label: string, value: boolean, title = '') {
  return `<label for="${id}"${title ? ` title="${escapeHtml(title)}"` : ''}>${label}</label><div><input type="checkbox" id="${id}" ${value ? 'checked' : ''}></div>`;
}

function bindRange(id: string, apply: (v: number) => void, show: (v: number) => string = String) {
  const el = $<HTMLInputElement>(id);
  if (!el) return;
  el.addEventListener('input', () => {
    (el.nextElementSibling as HTMLOutputElement).textContent = show(Number(el.value));
    apply(Number(el.value));
    changed();
  });
}

function bindCheck(id: string, apply: (v: boolean) => void) {
  const el = $<HTMLInputElement>(id);
  el?.addEventListener('change', () => {
    apply(el.checked);
    changed();
  });
}

// Envelope timings from the S-DSP documentation (time to full / to the sustain level / to silence).
const ATTACK_MS = [4100, 2600, 1500, 1000, 640, 380, 260, 160, 96, 64, 40, 24, 16, 10, 6, 0];
const DECAY_MS = [1200, 740, 440, 290, 180, 110, 74, 37];
const SR_MS = [Infinity, 38000, 28000, 24000, 19000, 14000, 12000, 9400, 7100, 5900, 4700, 3500, 2900, 2400, 1800, 1500, 1200, 880, 740, 590, 440, 370, 290, 220, 180, 150, 110, 92, 74, 55, 37, 18];
const ms = (v: number) => (v === Infinity ? '∞' : v >= 1000 ? `${num(v / 1000, 1)} s` : `${v} ms`);
const GAIN_MODES = ['direct', 'linDown', 'expDown', 'linUp', 'bentUp'] as const;
type GainMode = (typeof GAIN_MODES)[number];
const gainMode = (g: number): GainMode => (g < 0x80 ? 'direct' : GAIN_MODES[1 + ((g >> 5) & 3)]);
const gainValue = (mode: GainMode, v: number) => (mode === 'direct' ? v & 0x7f : 0x80 | (GAIN_MODES.indexOf(mode) - 1) * 0x20 | (v & 31));

function sampleOptions(selected: number) {
  return [`<option value="-1">${t('inst.noSample')}</option>`, ...song.samples.map((x, i) => `<option value="${i}" ${selected === i ? 'selected' : ''}>${hex2(i)} ${escapeHtml(x.name)}</option>`)].join('');
}

/** Draw the envelope the instrument makes while the key is held (measured on the DSP). */
function drawEnvelope(canvas: HTMLCanvasElement, ins: Instrument) {
  const ticks = 150; // 3 s at 50 ticks per second
  const curve = measureEnvelope(ins, 125, ticks);
  const g = canvas.getContext('2d')!;
  const css = getComputedStyle(document.documentElement);
  const w = canvas.width;
  const h = canvas.height;
  g.fillStyle = css.getPropertyValue('--scope-bg');
  g.fillRect(0, 0, w, h);
  g.strokeStyle = css.getPropertyValue('--scope-dim');
  g.lineWidth = 1;
  for (let s = 1; s < 3; s++) {
    const x = (s * 50 * w) / ticks;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, h);
    g.stroke();
  }
  g.strokeStyle = css.getPropertyValue('--scope-ink');
  g.lineWidth = 2;
  g.beginPath();
  curve.forEach((v, i) => {
    const x = (i / (ticks - 1)) * w;
    const y = h - 3 - (v / 127) * (h - 6);
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  });
  g.stroke();
}

function renderInstrumentPanel() {
  const ins = song.instruments[instIndex];
  const a = ins.adsr;
  const mode = gainMode(ins.gain);
  const gainShown = mode === 'direct' ? ins.gain & 0x7f : ins.gain & 31;
  const envForm =
    ins.envelope === 'adsr'
      ? slider('i-a', t('inst.attack'), a.attack, 0, 15, ms(ATTACK_MS[a.attack])) +
        slider('i-d', t('inst.decay'), a.decay, 0, 7, ms(DECAY_MS[a.decay])) +
        slider('i-s', t('inst.sustain'), a.sustain, 0, 7, `${(a.sustain + 1) * 125 / 10} %`) +
        slider('i-sr', t('inst.sustainRate'), a.sustainRate, 0, 31, ms(SR_MS[a.sustainRate]))
      : `<label for="i-gm">${t('inst.gainMode')}</label><select id="i-gm">${GAIN_MODES.map((m) => `<option value="${m}" ${m === mode ? 'selected' : ''}>${t(`inst.gain.${m}` as MessageKey)}</option>`).join('')}</select>` +
        slider('i-gv', t(mode === 'direct' ? 'inst.gainLevel' : 'inst.gainRate'), gainShown, 0, mode === 'direct' ? 127 : 31);
  panelEl.innerHTML = `
    <h2>${t('inst.title')}</h2>
    <div class="inst-grid">${Array.from({ length: INSTRUMENT_COUNT }, (_, i) => `<button type="button" data-ii="${i}" aria-pressed="${i === instIndex}">${insLabel(i)}</button>`).join('')}</div>
    <h2>${t('inst.heading', { n: insLabel(instIndex) })}</h2>
    <div class="form">
      <label for="i-name">${t('inst.name')}</label><input type="text" id="i-name" value="${escapeHtml(ins.name)}">
      <label for="i-sample">${t('inst.sample')}</label><select id="i-sample">${sampleOptions(ins.sample)}</select>
      ${slider('i-vol', t('inst.volume'), ins.volume, 0, 127)}
      ${slider('i-pan', t('inst.pan'), ins.pan, 0, 255, panText(ins.pan))}
      ${slider('i-tr', t('inst.transpose'), ins.transpose, -48, 48)}
      ${slider('i-ft', t('inst.finetune'), ins.finetune, -128, 127)}
    </div>
    <h2>${t('inst.envelope')}</h2>
    <div class="seg" role="group"><button type="button" data-env="adsr" aria-pressed="${ins.envelope === 'adsr'}">ADSR</button><button type="button" data-env="gain" aria-pressed="${ins.envelope === 'gain'}">GAIN</button></div>
    <canvas class="env-canvas" id="env-canvas" width="320" height="90" aria-label="${t('inst.envelopeGraph')}"></canvas>
    <div class="form">
      ${envForm}
      ${slider('i-rel', t('inst.release'), ins.release, 0, 31, ins.release ? ms(SR_MS[ins.release]) : t('inst.keyOff'))}
    </div>
    <h2>${t('inst.voice')}</h2>
    <div class="form">
      ${check('i-echo', t('inst.echo'), ins.echo)}
      ${check('i-noise', t('inst.noise'), ins.noise, t('inst.noiseHint'))}
      ${check('i-pmod', t('inst.pitchMod'), ins.pitchMod, t('inst.pitchModHint'))}
    </div>
    <div class="btn-row">
      <button type="button" class="btn primary" id="i-test">${t('inst.test')}</button>
      <button type="button" class="btn" id="i-use">${t('inst.use')}</button>
      <button type="button" class="btn" id="i-copy">${t('inst.copy')}</button>
      <button type="button" class="btn" id="i-paste" ${instClipboard ? '' : 'disabled'}>${t('inst.paste')}</button>
      <button type="button" class="btn" id="i-reset">${t('inst.reset')}</button>
    </div>
    <p class="hint">${t('inst.hint')}</p>`;

  const canvas = $<HTMLCanvasElement>('env-canvas');
  let envFrame = 0;
  const redraw = () => {
    cancelAnimationFrame(envFrame);
    envFrame = requestAnimationFrame(() => drawEnvelope(canvas, ins));
  };
  redraw();
  panelEl.querySelectorAll<HTMLButtonElement>('[data-ii]').forEach((b) =>
    b.addEventListener('click', () => {
      instIndex = Number(b.dataset.ii);
      renderPanel();
    }),
  );
  $<HTMLInputElement>('i-name').addEventListener('input', (e) => {
    ins.name = (e.target as HTMLInputElement).value;
    renderInstList();
    changed();
  });
  $<HTMLSelectElement>('i-sample').addEventListener('change', (e) => {
    ins.sample = Number((e.target as HTMLSelectElement).value);
    renderInstList();
    changed();
  });
  bindRange('i-vol', (v) => (ins.volume = v));
  bindRange('i-pan', (v) => (ins.pan = v), panText);
  bindRange('i-tr', (v) => (ins.transpose = v));
  bindRange('i-ft', (v) => (ins.finetune = v));
  panelEl.querySelectorAll<HTMLButtonElement>('[data-env]').forEach((b) =>
    b.addEventListener('click', () => {
      ins.envelope = b.dataset.env as Instrument['envelope'];
      changed();
      renderPanel();
    }),
  );
  if (ins.envelope === 'adsr') {
    bindRange('i-a', (v) => ((a.attack = v), redraw()), (v) => ms(ATTACK_MS[v]));
    bindRange('i-d', (v) => ((a.decay = v), redraw()), (v) => ms(DECAY_MS[v]));
    bindRange('i-s', (v) => ((a.sustain = v), redraw()), (v) => `${num(((v + 1) * 100) / 8, 1)} %`);
    bindRange('i-sr', (v) => ((a.sustainRate = v), redraw()), (v) => ms(SR_MS[v]));
  } else {
    $<HTMLSelectElement>('i-gm').addEventListener('change', (e) => {
      const m = (e.target as HTMLSelectElement).value as GainMode;
      ins.gain = gainValue(m, m === 'direct' ? 0x7f : 20);
      changed();
      renderPanel();
    });
    bindRange('i-gv', (v) => ((ins.gain = gainValue(mode, v)), redraw()));
  }
  bindRange('i-rel', (v) => (ins.release = v), (v) => (v ? ms(SR_MS[v]) : t('inst.keyOff')));
  bindCheck('i-echo', (v) => (ins.echo = v));
  bindCheck('i-noise', (v) => {
    ins.noise = v;
    renderInstList();
  });
  bindCheck('i-pmod', (v) => (ins.pitchMod = v));
  const test = $('i-test');
  // Voice 2 when the instrument uses pitch modulation (voice 1 cannot), else voice 1.
  const testChannel = () => (ins.pitchMod ? 1 : 0);
  test.addEventListener('pointerdown', () => preview(testChannel(), octave * 12, instIndex));
  test.addEventListener('pointerup', () => release(testChannel()));
  test.addEventListener('pointerleave', () => release(testChannel()));
  $('i-use').addEventListener('click', () => {
    instrument = instIndex;
    renderHeader();
    toast(t('inst.selected', { n: insLabel(instIndex) }));
  });
  $('i-copy').addEventListener('click', () => {
    instClipboard = structuredClone(ins);
    toast(t('inst.copied', { n: insLabel(instIndex) }));
    renderPanel();
  });
  $('i-paste').addEventListener('click', () => {
    if (!instClipboard) return;
    song.instruments[instIndex] = structuredClone(instClipboard);
    changed(true);
  });
  $('i-reset').addEventListener('click', () => {
    if (!confirm(t('inst.confirmReset', { n: insLabel(instIndex) }))) return;
    const fresh = createSong().instruments[instIndex];
    song.instruments[instIndex] = { ...fresh, sample: fresh.sample < song.samples.length ? fresh.sample : -1 };
    changed(true);
  });
}

let instClipboard: Instrument | null = null;

function panText(p: number) {
  if (p === 128) return 'C';
  return p < 128 ? `L${128 - p}` : `R${p - 128}`;
}

// ----------------------------------------------------------------- samples

/** Bar showing how the 64 KiB of audio RAM are used. */
function aramMeter() {
  const layout = layoutAram(song);
  const total = 0x10000;
  const system = 0x500;
  const samples = layout.end - system;
  const echo = total - layout.echoStart;
  const free = layout.free;
  const pct = (v: number) => `${Math.max(0, (v / total) * 100).toFixed(2)}%`;
  return `<div class="aram" role="img" aria-label="${escapeHtml(t('aram.label', { samples: kib(samples), echo: kib(echo), free: kib(Math.max(0, free)) }))}">
      <span class="aram-sys" style="width:${pct(system)}"></span><span class="aram-smp" style="width:${pct(samples)}"></span><span class="aram-free" style="width:${pct(Math.max(0, free))}"></span><span class="aram-echo" style="width:${pct(echo)}"></span>
    </div>
    <div class="aram-legend"><span class="k-smp">${t('aram.samples', { size: kib(samples) })}</span><span class="k-echo">${t('aram.echo', { size: kib(echo) })}</span><span class="k-free">${t('aram.free', { size: kib(Math.max(0, free)) })}</span></div>
    ${free < 0 ? `<p class="hint warn">${t('aram.overlap', { size: kib(-free) })}</p>` : ''}`;
}

function drawWave(canvas: HTMLCanvasElement, pcm: ArrayLike<number>, loopStart = -1, scale = 32768) {
  const g = canvas.getContext('2d')!;
  const css = getComputedStyle(document.documentElement);
  const w = canvas.width;
  const h = canvas.height;
  g.fillStyle = css.getPropertyValue('--scope-bg');
  g.fillRect(0, 0, w, h);
  const n = pcm.length;
  if (!n) return;
  if (loopStart >= 0) {
    g.fillStyle = css.getPropertyValue('--scope-dim');
    const x = (loopStart / n) * w;
    g.fillRect(x, 0, w - x, h);
  }
  g.strokeStyle = css.getPropertyValue('--scope-ink');
  g.lineWidth = 1.5;
  g.beginPath();
  if (n <= w) {
    for (let i = 0; i < n; i++) {
      const x = (i / Math.max(1, n - 1)) * w;
      const y = h / 2 - (pcm[i] / scale) * (h / 2 - 2);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
  } else {
    // Min/max per pixel column.
    for (let x = 0; x < w; x++) {
      const from = Math.floor((x / w) * n);
      const to = Math.max(from + 1, Math.floor(((x + 1) / w) * n));
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = from; i < to; i++) {
        lo = Math.min(lo, pcm[i]);
        hi = Math.max(hi, pcm[i]);
      }
      g.moveTo(x + 0.5, h / 2 - (hi / scale) * (h / 2 - 2));
      g.lineTo(x + 0.5, h / 2 - (lo / scale) * (h / 2 - 2) + 1);
    }
  }
  g.stroke();
}

function sampleInfo(s: Sample) {
  const bytes = sampleBytes(s).length;
  const pcm = decodeSample(s);
  return t('smpl.info', { bytes, blocks: sampleBlocks(s), seconds: num(pcm.length / s.rate, 2), rate: s.rate });
}

function replaceSample(i: number, next: Sample) {
  song.samples[i] = next;
  changed();
  renderPanel();
  renderAramBadge();
}

function addSample(s: Sample) {
  if (song.samples.length >= SAMPLE_COUNT) {
    toast(t('smpl.full', { max: SAMPLE_COUNT }));
    return false;
  }
  song.samples.push(s);
  sampleIndex = song.samples.length - 1;
  changed();
  renderPanel();
  renderAramBadge();
  toast(t('smpl.added', { n: hex2(sampleIndex), name: s.name }));
  return true;
}

function renderSamplePanel() {
  if (sampleIndex >= song.samples.length) sampleIndex = Math.max(0, song.samples.length - 1);
  const s = song.samples[sampleIndex] as Sample | undefined;
  const blocks = s ? sampleBlocks(s) : 0;
  const shapeOptions = WAVE_SHAPES.map((sh) => `<button type="button" data-shape="${sh}" aria-pressed="${waveParams.shape === sh}">${t(`synth.shape.${sh}` as MessageKey)}</button>`).join('');
  const shapeForm =
    waveParams.shape === 'square'
      ? slider('w-duty', t('synth.duty'), waveParams.duty, 1, 99, `${waveParams.duty} %`)
      : waveParams.shape === 'harmonics'
        ? `<label>${t('synth.harmonics')}</label><div class="harmonics">${waveParams.harmonics
            .map((v, i) => `<input type="range" min="0" max="100" value="${Math.round(v * 100)}" data-h="${i}" aria-label="${t('synth.harmonic', { n: i + 1 })}" orient="vertical">`)
            .join('')}</div>`
        : '';
  panelEl.innerHTML = `
    <h2>${t('aram.title')}</h2>
    ${aramMeter()}
    <h2>${t('smpl.title', { count: song.samples.length, max: SAMPLE_COUNT })}</h2>
    <div class="sample-list" id="sample-list">${song.samples
      .map(
        (x, i) => `<div class="sample-row" aria-current="${i === sampleIndex}" data-srow="${i}">
          <button type="button" class="sample-num" data-ssel="${i}" title="${t('smpl.select')}">${hex2(i)}</button>
          <input type="text" data-sname="${i}" value="${escapeHtml(x.name)}" aria-label="${t('smpl.name')}">
          <span class="sample-len">${kib(sampleBytes(x).length)}</span>
          <button type="button" class="btn" data-splay="${i}" aria-label="${t('smpl.play')}">▶</button>
        </div>`,
      )
      .join('')}</div>
    <div class="btn-row">
      <button type="button" class="btn primary" id="s-import" ${song.samples.length >= SAMPLE_COUNT ? 'disabled' : ''}>${t('smpl.import')}</button>
      <select id="s-rate" class="btn" aria-label="${t('smpl.importRate')}" title="${t('smpl.importRate')}">${[32000, 16000, 11025, 8000].map((r) => `<option value="${r}" ${r === importRate ? 'selected' : ''}>${num(r / 1000, r % 1000 ? 3 : 0)} kHz</option>`).join('')}</select>
    </div>
    <input type="file" id="s-file" accept="audio/*,.wav,.mp3,.ogg,.flac" multiple class="visually-hidden">
    <p class="hint">${t('smpl.importHint')}</p>
    ${
      s
        ? `<h2>${t('smpl.heading', { n: hex2(sampleIndex), name: escapeHtml(s.name) })}</h2>
    <canvas class="wave-canvas" id="s-wave" width="640" height="160" aria-label="${t('smpl.waveform')}"></canvas>
    <p class="hint" id="s-info">${sampleInfo(s)}</p>
    <div class="form">
      ${check('s-loop', t('smpl.loop'), s.loop >= 0)}
      ${s.loop >= 0 ? slider('s-loopstart', t('smpl.loopStart'), s.loop, 0, Math.max(0, blocks - 1), t('smpl.block', { n: s.loop, sample: s.loop * 16 })) : ''}
      <label for="s-hz">${t('smpl.rate')}</label><div class="range"><input type="number" id="s-hz" min="1" max="128000" value="${s.rate}"><output>Hz</output></div>
      <label>${t('smpl.tune')}</label>
      <div class="btn-row tight"><button type="button" class="btn" data-tune="-12">−12</button><button type="button" class="btn" data-tune="-1">−1</button><button type="button" class="btn" data-tune="1">+1</button><button type="button" class="btn" data-tune="12">+12</button></div>
    </div>
    <div class="btn-row">
      <button type="button" class="btn" id="s-normalize">${t('smpl.normalize')}</button>
      <button type="button" class="btn" id="s-reverse">${t('smpl.reverse')}</button>
      <button type="button" class="btn" id="s-halve">${t('smpl.halve')}</button>
      <button type="button" class="btn" id="s-dup">${t('smpl.duplicate')}</button>
      <button type="button" class="btn" id="s-wav">${t('smpl.exportWav')}</button>
      <button type="button" class="btn" id="s-inst">${t('smpl.toInstrument')}</button>
      <button type="button" class="btn" id="s-del">${t('smpl.delete')}</button>
    </div>`
        : `<p class="hint">${t('smpl.none')}</p>`
    }
    <h2>${t('synth.title')}</h2>
    <div class="seg wrap" role="group">${shapeOptions}</div>
    <canvas class="wave-canvas small" id="w-preview" width="320" height="100" aria-label="${t(waveParams.shape === 'drawn' ? 'synth.draw' : 'synth.preview')}"></canvas>
    <div class="form">
      ${shapeForm}
      <label for="w-len">${t('synth.length')}</label><select id="w-len">${CYCLE_LENGTHS.map((l) => `<option value="${l}" ${l === waveParams.length ? 'selected' : ''}>${l}</option>`).join('')}</select>
      ${slider('w-vol', t('synth.volume'), Math.round(waveParams.volume * 100), 5, 100, `${Math.round(waveParams.volume * 100)} %`)}
    </div>
    <div class="btn-row">
      <button type="button" class="btn" id="w-play">${t('synth.listen')}</button>
      <button type="button" class="btn primary" id="w-add">${t('synth.add')}</button>
      <button type="button" class="btn" id="w-replace" ${s ? '' : 'disabled'}>${t('synth.replace')}</button>
    </div>
    <p class="hint">${t('synth.waveHint')}</p>
    <h2>${t('drum.title')}</h2>
    <div class="form">
      <label for="d-kind">${t('drum.kind')}</label><select id="d-kind">${DRUM_KINDS.map((k) => `<option value="${k}" ${k === drumParams.kind ? 'selected' : ''}>${t(`drum.${k}` as MessageKey)}</option>`).join('')}</select>
      ${slider('d-pitch', t('drum.pitch'), Math.round(drumParams.pitch), 20, 12000, `${Math.round(drumParams.pitch)} Hz`)}
      ${slider('d-decay', t('drum.decay'), Math.round(drumParams.decay * 1000), 10, 2000, ms(Math.round(drumParams.decay * 1000)))}
      ${slider('d-noise', t('drum.noise'), Math.round(drumParams.noise * 100), 0, 100, `${Math.round(drumParams.noise * 100)} %`)}
      <label for="d-rate">${t('drum.rate')}</label><select id="d-rate">${[32000, 16000, 8000].map((r) => `<option value="${r}" ${r === drumParams.rate ? 'selected' : ''}>${r / 1000} kHz</option>`).join('')}</select>
    </div>
    <canvas class="wave-canvas small" id="d-preview" width="320" height="80" aria-label="${t('synth.preview')}"></canvas>
    <div class="btn-row">
      <button type="button" class="btn" id="d-play">${t('synth.listen')}</button>
      <button type="button" class="btn primary" id="d-add">${t('synth.add')}</button>
      <button type="button" class="btn" id="d-replace" ${s ? '' : 'disabled'}>${t('synth.replace')}</button>
    </div>`;

  // Sample list
  panelEl.querySelectorAll<HTMLButtonElement>('[data-ssel]').forEach((b) =>
    b.addEventListener('click', () => {
      sampleIndex = Number(b.dataset.ssel);
      renderPanel();
    }),
  );
  panelEl.querySelectorAll<HTMLInputElement>('[data-sname]').forEach((el) => {
    el.addEventListener('focus', () => {
      if (sampleIndex === Number(el.dataset.sname)) return;
      sampleIndex = Number(el.dataset.sname);
      panelEl.querySelectorAll('[data-srow]').forEach((r) => r.setAttribute('aria-current', String(r.getAttribute('data-srow') === el.dataset.sname)));
    });
    el.addEventListener('input', () => {
      song.samples[Number(el.dataset.sname)].name = el.value;
      changed();
    });
    el.addEventListener('change', () => renderPanel());
  });
  panelEl.querySelectorAll<HTMLButtonElement>('[data-splay]').forEach((b) =>
    b.addEventListener('click', () => {
      void ensureAudio();
      audio.send({ type: 'sample', index: Number(b.dataset.splay), note: C4 });
    }),
  );
  const input = $<HTMLInputElement>('s-file');
  $('s-import').addEventListener('click', () => input.click());
  $<HTMLSelectElement>('s-rate').addEventListener('change', (e) => (importRate = Number((e.target as HTMLSelectElement).value)));
  input.addEventListener('change', async () => {
    const files = [...(input.files ?? [])];
    input.value = '';
    for (const file of files) {
      try {
        const { channels, rate } = await decodeAudioFile(file);
        const sample = sampleFromAudio(file.name.replace(/\.[^.]*$/, '').slice(0, 24), channels, rate, importRate);
        if (!addSample(sample)) break;
        track('sample-import', { rate: importRate });
      } catch (err) {
        toast(t('smpl.importError', { error: (err as Error).message }));
      }
    }
  });

  if (s) {
    const pcm = decodeSample(s);
    drawWave($<HTMLCanvasElement>('s-wave'), pcm, s.loop >= 0 ? s.loop * 16 : -1);
    $<HTMLInputElement>('s-loop').addEventListener('change', (e) => {
      replaceSample(sampleIndex, setLoop(s, (e.target as HTMLInputElement).checked ? Math.max(0, s.loop) : -1));
    });
    const loopStart = document.getElementById('s-loopstart') as HTMLInputElement | null;
    loopStart?.addEventListener('input', () => {
      const block = Number(loopStart.value);
      (loopStart.nextElementSibling as HTMLOutputElement).textContent = t('smpl.block', { n: block, sample: block * 16 });
      s.loop = block;
      drawWave($<HTMLCanvasElement>('s-wave'), pcm, block * 16);
      changed();
    });
    loopStart?.addEventListener('change', () => renderAramBadge());
    $<HTMLInputElement>('s-hz').addEventListener('change', (e) => {
      const v = Math.round(Number((e.target as HTMLInputElement).value));
      if (v >= 1 && v <= 128000) replaceSample(sampleIndex, { ...s, rate: v });
    });
    panelEl.querySelectorAll<HTMLButtonElement>('[data-tune]').forEach((b) =>
      b.addEventListener('click', () => replaceSample(sampleIndex, retuneSample(s, Number(b.dataset.tune)))),
    );
    $('s-normalize').addEventListener('click', () => replaceSample(sampleIndex, normalizeSample(s)));
    $('s-reverse').addEventListener('click', () => replaceSample(sampleIndex, reverseSample(s)));
    $('s-halve').addEventListener('click', () => replaceSample(sampleIndex, halveSample(s)));
    $('s-dup').addEventListener('click', () => addSample({ ...s, name: `${s.name} 2` }));
    $('s-wav').addEventListener('click', () => {
      const f = Float32Array.from(pcm, (v) => v / 32768);
      download(`${fileName(s.name)}.wav`, encodeWav(f, f, s.rate) as BlobPart, 'audio/wav');
    });
    $('s-inst').addEventListener('click', () => {
      const free = song.instruments.findIndex((x) => x.sample < 0 && !x.noise);
      if (free < 0) return toast(t('smpl.noFreeInstrument'));
      song.instruments[free] = { ...song.instruments[free], name: s.name, sample: sampleIndex };
      instIndex = instrument = free;
      changed(true);
      toast(t('smpl.instrumentMade', { n: insLabel(free), name: s.name }));
    });
    $('s-del').addEventListener('click', () => {
      if (!confirm(t('smpl.confirmDelete', { name: s.name }))) return;
      deleteSample(song, sampleIndex);
      changed(true);
    });
  }

  // Waveform synth
  const wavePreview = $<HTMLCanvasElement>('w-preview');
  const drawSynth = () => drawWave(wavePreview, waveCycle(waveParams), -1, 1);
  drawSynth();
  panelEl.querySelectorAll<HTMLButtonElement>('[data-shape]').forEach((b) =>
    b.addEventListener('click', () => {
      waveParams = { ...waveParams, shape: b.dataset.shape as WaveShape };
      renderPanel();
    }),
  );
  const duty = document.getElementById('w-duty') as HTMLInputElement | null;
  duty?.addEventListener('input', () => {
    waveParams.duty = Number(duty.value);
    (duty.nextElementSibling as HTMLOutputElement).textContent = `${duty.value} %`;
    drawSynth();
  });
  panelEl.querySelectorAll<HTMLInputElement>('[data-h]').forEach((el) =>
    el.addEventListener('input', () => {
      waveParams.harmonics[Number(el.dataset.h)] = Number(el.value) / 100;
      drawSynth();
    }),
  );
  $<HTMLSelectElement>('w-len').addEventListener('change', (e) => {
    waveParams.length = Number((e.target as HTMLSelectElement).value);
    drawSynth();
  });
  const wvol = $<HTMLInputElement>('w-vol');
  wvol.addEventListener('input', () => {
    waveParams.volume = Number(wvol.value) / 100;
    (wvol.nextElementSibling as HTMLOutputElement).textContent = `${wvol.value} %`;
    drawSynth();
  });
  if (waveParams.shape === 'drawn') {
    let drawing = false;
    const paint = (e: PointerEvent) => {
      const r = wavePreview.getBoundingClientRect();
      const pts = waveParams.points;
      const i = Math.max(0, Math.min(pts.length - 1, Math.floor(((e.clientX - r.left) / r.width) * pts.length)));
      pts[i] = Math.max(-1, Math.min(1, 1 - ((e.clientY - r.top) / r.height) * 2));
      drawSynth();
    };
    wavePreview.classList.add('drawable');
    wavePreview.addEventListener('pointerdown', (e) => {
      drawing = true;
      wavePreview.setPointerCapture(e.pointerId);
      paint(e);
    });
    wavePreview.addEventListener('pointermove', (e) => drawing && paint(e));
    wavePreview.addEventListener('pointerup', () => (drawing = false));
  }
  const synthName = () => t(`synth.shape.${waveParams.shape}` as MessageKey);
  $('w-play').addEventListener('click', () => {
    const smp = waveSample('', waveParams);
    // Two seconds of the loop at C-4.
    const cycle = Float32Array.from(decodeSample(smp), (v) => v / 32768);
    const out = new Float32Array(Math.round(smp.rate));
    for (let i = 0; i < out.length; i++) out[i] = cycle[i % cycle.length] * 0.6;
    void audio.playBuffer(out, smp.rate);
  });
  $('w-add').addEventListener('click', () => addSample(waveSample(synthName(), waveParams)));
  $('w-replace').addEventListener('click', () => s && replaceSample(sampleIndex, waveSample(s.name, waveParams)));

  // Drum synth
  const drumPreview = $<HTMLCanvasElement>('d-preview');
  const drawDrum = () => drawWave(drumPreview, decodeSample(drumSample('', drumParams)));
  drawDrum();
  $<HTMLSelectElement>('d-kind').addEventListener('change', (e) => {
    drumParams = defaultDrum((e.target as HTMLSelectElement).value as DrumKind);
    renderPanel();
  });
  const drumRange = (id: string, apply: (v: number) => void, show: (v: number) => string) => {
    const el = $<HTMLInputElement>(id);
    el.addEventListener('input', () => {
      apply(Number(el.value));
      (el.nextElementSibling as HTMLOutputElement).textContent = show(Number(el.value));
    });
    el.addEventListener('change', drawDrum);
  };
  drumRange('d-pitch', (v) => (drumParams.pitch = v), (v) => `${v} Hz`);
  drumRange('d-decay', (v) => (drumParams.decay = v / 1000), (v) => ms(v));
  drumRange('d-noise', (v) => (drumParams.noise = v / 100), (v) => `${v} %`);
  $<HTMLSelectElement>('d-rate').addEventListener('change', (e) => {
    drumParams.rate = Number((e.target as HTMLSelectElement).value);
    drawDrum();
  });
  const drumName = () => t(`drum.${drumParams.kind}` as MessageKey);
  $('d-play').addEventListener('click', () => {
    const smp = drumSample('', drumParams);
    void audio.playBuffer(Float32Array.from(decodeSample(smp), (v) => (v / 32768) * 0.8), smp.rate);
  });
  $('d-add').addEventListener('click', () => addSample(drumSample(drumName(), drumParams)));
  $('d-replace').addEventListener('click', () => s && replaceSample(sampleIndex, drumSample(s.name, drumParams)));
}

/** Decode any audio file the browser understands to PCM. */
async function decodeAudioFile(file: File): Promise<{ channels: Float32Array[]; rate: number }> {
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  return { channels, rate: buffer.sampleRate };
}

// -------------------------------------------------------------------- song

function renderSongPanel() {
  const e = song.echo;
  const rowsOptions = [16, 32, 48, 64, 96, 128, 192, 256].filter((r) => r <= MAX_ROWS);
  const curRows = pattern().rows.length;
  const tickHz = (bpm: number) => t('song.tickRate', { hz: num((bpm * 2) / 5, 1), ms: num(2500 / bpm, 1) });
  panelEl.innerHTML = `
    <h2>${t('song.title')}</h2>
    <div class="form">
      <label for="s-title">${t('song.songTitle')}</label><input type="text" id="s-title">
      <label for="s-author">${t('song.author')}</label><input type="text" id="s-author">
      ${slider('s-bpm', t('song.bpm'), song.bpm, MIN_BPM, MAX_BPM)}
      <label></label><div class="hint" id="s-tick">${tickHz(song.bpm)}</div>
      ${slider('s-speed', t('song.speed'), song.speed, 1, 31)}
      ${slider('s-mvol', t('song.volume'), song.volume, 0, 127)}
    </div>
    <h2>${t('echo.title')}</h2>
    <div class="form">
      ${slider('e-delay', t('echo.delay'), e.delay, 0, 15, `${e.delay * 16} ms`)}
      ${slider('e-fb', t('echo.feedback'), e.feedback, -128, 127)}
      ${slider('e-vl', t('echo.volumeL'), e.volumeL, -128, 127)}
      ${slider('e-vr', t('echo.volumeR'), e.volumeR, -128, 127)}
      <label>${t('echo.fir')}</label>
      <div class="fir">${e.fir.map((c, i) => `<input type="number" min="-128" max="127" value="${c}" data-fir="${i}" aria-label="${t('echo.tap', { n: i })}">`).join('')}</div>
      <label>${t('echo.presets')}</label>
      <div class="btn-row tight">${Object.keys(FIR_PRESETS).map((p) => `<button type="button" class="btn" data-firp="${p}">${t(`echo.preset.${p}` as MessageKey)}</button>`).join('')}</div>
    </div>
    <p class="hint">${t('echo.hint')}</p>
    ${aramMeter()}
    <h2>${t('song.pattern', { n: hex2(song.order[order]) })}</h2>
    <div class="form">
      <label for="p-rows">${t('song.rows')}</label><select id="p-rows">${[...new Set([...rowsOptions, curRows])].sort((a, b) => a - b).map((r) => `<option value="${r}" ${r === curRows ? 'selected' : ''}>${r}</option>`).join('')}</select>
    </div>
    <div class="btn-row">
      <button type="button" class="btn" id="p-new">${t('song.newPattern')}</button>
      <button type="button" class="btn" id="p-clone">${t('song.duplicate')}</button>
      <button type="button" class="btn" id="p-clear">${t('song.clear')}</button>
      <button type="button" class="btn" id="p-up">${t('song.up')}</button>
      <button type="button" class="btn" id="p-down">${t('song.down')}</button>
      <button type="button" class="btn" id="p-delrow">${t('song.deleteRow')}</button>
    </div>
    <div class="form" style="margin-top:10px">${check('s-follow', t('song.follow'), follow)}</div>`;
  const title = $<HTMLInputElement>('s-title');
  const author = $<HTMLInputElement>('s-author');
  title.value = song.title;
  author.value = song.author;
  title.addEventListener('input', () => {
    song.title = title.value;
    changed();
  });
  author.addEventListener('input', () => {
    song.author = author.value;
    changed();
  });
  bindRange('s-bpm', (v) => {
    song.bpm = v;
    $('bpm').textContent = String(v);
    $('s-tick').textContent = tickHz(v);
  });
  bindRange('s-speed', (v) => {
    song.speed = v;
    $('spd').textContent = String(v);
  });
  bindRange('s-mvol', (v) => (song.volume = v));
  bindRange('e-delay', (v) => (e.delay = v), (v) => `${v * 16} ms`);
  $('e-delay').addEventListener('change', () => renderPanel());
  bindRange('e-fb', (v) => (e.feedback = v));
  bindRange('e-vl', (v) => (e.volumeL = v));
  bindRange('e-vr', (v) => (e.volumeR = v));
  panelEl.querySelectorAll<HTMLInputElement>('[data-fir]').forEach((el) =>
    el.addEventListener('change', () => {
      e.fir[Number(el.dataset.fir)] = Math.max(-128, Math.min(127, Math.round(Number(el.value) || 0)));
      el.value = String(e.fir[Number(el.dataset.fir)]);
      changed();
    }),
  );
  panelEl.querySelectorAll<HTMLButtonElement>('[data-firp]').forEach((b) =>
    b.addEventListener('click', () => {
      e.fir = [...FIR_PRESETS[b.dataset.firp!]];
      changed();
      renderPanel();
    }),
  );
  $<HTMLSelectElement>('p-rows').addEventListener('change', (ev) => {
    resizePattern(pattern(), Number((ev.target as HTMLSelectElement).value));
    if (cursor.row >= pattern().rows.length) cursor = { ...cursor, row: pattern().rows.length - 1 };
    changed(true);
  });
  $('p-new').addEventListener('click', () => {
    song.patterns.push(emptyPattern());
    song.order.splice(order + 1, 0, song.patterns.length - 1);
    order++;
    changed(true);
  });
  $('p-clone').addEventListener('click', () => {
    song.patterns.push(clonePattern(pattern()));
    song.order.splice(order + 1, 0, song.patterns.length - 1);
    order++;
    changed(true);
  });
  $('p-clear').addEventListener('click', () => {
    if (!confirm(t('song.confirmClear'))) return;
    song.patterns[song.order[order]] = emptyPattern(pattern().rows.length);
    changed(true);
  });
  $('p-up').addEventListener('click', () => {
    transposeBlock(pattern(), { r0: 0, r1: pattern().rows.length - 1, c0: cursor.ch, c1: cursor.ch }, 1);
    changed(true);
  });
  $('p-down').addEventListener('click', () => {
    transposeBlock(pattern(), { r0: 0, r1: pattern().rows.length - 1, c0: cursor.ch, c1: cursor.ch }, -1);
    changed(true);
  });
  $('p-delrow').addEventListener('click', () => {
    deleteRow(pattern(), cursor.ch, cursor.row);
    changed(true);
  });
  // Following playback is a view setting, not a change to the song.
  $<HTMLInputElement>('s-follow').addEventListener('change', (ev) => (follow = (ev.target as HTMLInputElement).checked));
}

// -------------------------------------------------------------------- file

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const fileBase = () => fileName(song.title);

function renderFilePanel() {
  panelEl.innerHTML = `
    <h2>${t('file.title')}</h2>
    <div class="current-song"><strong>${escapeHtml(song.title || t('lib.untitled'))}</strong> <span class="song-state" id="f-state"></span></div>
    <div class="btn-row">
      <button type="button" class="btn" id="f-new">${t('file.new')}</button>
      <button type="button" class="btn primary" id="f-store" title="${t('file.storeTitle')}">${t('file.store')}</button>
      <button type="button" class="btn" id="f-saveas">${t('file.saveAs')}</button>
      <button type="button" class="btn" id="f-demo">${t('file.demo')}</button>
    </div>
    <h2>${t('lib.title', { count: libraryList.length })}</h2>
    <input type="search" class="lib-search" id="lib-search" placeholder="${t('lib.search')}" aria-label="${t('lib.search')}" value="${escapeHtml(libraryFilter)}">
    <div class="lib-list" id="lib-list"></div>
    <p class="hint">${t(!library ? 'lib.loading' : libraryPersistent ? 'lib.hint' : 'lib.memory')}</p>
    <div class="btn-row">
      <button type="button" class="btn" id="f-open">${t('file.open')}</button>
      <button type="button" class="btn" id="f-save">${t('file.save')}</button>
      <button type="button" class="btn" id="f-backup">${t('file.backup')}</button>
    </div>
    <input type="file" id="f-input" accept=".json,.zip,application/json,application/zip" multiple class="visually-hidden">
    <p class="hint">${t('file.autosave')}</p>
    <h2>${t('export.title')}</h2>
    <div class="form">${slider('x-loops', t('export.loops'), 1, 1, 4)}</div>
    <div class="btn-row">
      <button type="button" class="btn primary" id="x-spc">${t('export.spc')}</button>
      <button type="button" class="btn" id="x-wav">${t('export.wav')}</button>
      <button type="button" class="btn" id="x-mp3">${t('export.mp3')}</button>
      <button type="button" class="btn" id="x-mp4">${t('export.mp4')}</button>
      <button type="button" class="btn" id="x-xm">${t('export.xm')}</button>
      <button type="button" class="btn" id="x-stems">${t('export.stems')}</button>
    </div>
    <p class="hint" id="x-status">${t('export.hint')}</p>`;
  renderSongState();
  renderLibraryList();
  const input = $<HTMLInputElement>('f-input');
  $('f-new').addEventListener('click', () => {
    if (!confirmDiscard()) return;
    loadSong(createSong(), null);
    track('song-new');
  });
  $('f-demo').addEventListener('click', () => {
    if (!confirmDiscard()) return;
    loadSong(demoSong(), null);
    track('song-demo');
  });
  $('f-store').addEventListener('click', () => void saveToLibrary());
  $('f-saveas').addEventListener('click', () => {
    const title = prompt(t('lib.saveAsPrompt'), song.title + t('lib.copySuffix'));
    if (title === null) return;
    song.title = title.trim() || song.title;
    void saveToLibrary(true);
  });
  $<HTMLInputElement>('lib-search').addEventListener('input', (e) => {
    libraryFilter = (e.target as HTMLInputElement).value;
    renderLibraryList();
  });
  $('lib-list').addEventListener('click', (e) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
    const id = button?.closest<HTMLElement>('[data-id]')?.dataset.id;
    if (button && id) void libraryAction(button.dataset.act!, id);
  });
  $('f-open').addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length) await importFiles(files);
  });
  $('f-save').addEventListener('click', () => {
    download(`${fileBase()}.snes.json`, JSON.stringify(song), 'application/json');
    track('export', { format: 'json' });
  });
  $('f-backup').addEventListener('click', () => void backupLibrary());
  bindRange('x-loops', () => {});
  const status = () => $('x-status');
  /** Render with progress in the status line, then hand over the file. */
  const exportAudio = (
    id: string,
    build: (opts: RenderOptions) => Promise<{ name: string; data: Uint8Array; type: string; seconds: number; warnings?: string[] }>,
  ) =>
    $(id).addEventListener('click', async () => {
      const btn = $<HTMLButtonElement>(id);
      btn.disabled = true;
      try {
        const { name, data, type, seconds, warnings } = await build({
          loops: Number($<HTMLInputElement>('x-loops').value),
          onProgress: (sec) => (status().textContent = t('export.rendering', { seconds: num(sec, 0) })),
        });
        download(name, data as BlobPart, type);
        track('export', { format: id.slice(2) });
        status().textContent = t('export.ready', { name, seconds: num(seconds, 1), size: kib(data.length) });
        if (warnings?.length) status().textContent += ` ${t('export.approxHint', { list: warnings.join(', ') })}`;
      } catch (err) {
        status().textContent = (err as Error).message;
      } finally {
        btn.disabled = false;
      }
    });
  exportAudio('x-wav', async (opts) => {
    const { left, right, sampleRate } = await renderSong(structuredClone(song), opts);
    const data = encodeWav(left, right, sampleRate);
    return { name: `${fileBase()}.wav`, data, type: 'audio/wav', seconds: left.length / sampleRate };
  });
  exportAudio('x-mp3', async (opts) => {
    status().textContent = t('export.preparing');
    const { exportMp3 } = await import('./export/video');
    const { data, seconds } = await exportMp3(structuredClone(song), { loops: opts.loops ?? 1, onProgress: opts.onProgress });
    return { name: `${fileBase()}.mp3`, data, type: 'audio/mpeg', seconds };
  });
  exportAudio('x-mp4', async (opts) => {
    status().textContent = t('export.preparing');
    const { canExportVideo, exportMp4, themeColors } = await import('./export/video');
    if (!(await canExportVideo())) throw new Error(t('export.unsupported'));
    const colors = themeColors(getComputedStyle(document.documentElement));
    const { data, seconds } = await exportMp4(structuredClone(song), { loops: opts.loops ?? 1, onProgress: opts.onProgress, colors });
    return { name: `${fileBase()}.mp4`, data, type: 'video/mp4', seconds };
  });
  exportAudio('x-stems', async (opts) => {
    const stems = await renderStems(song, opts);
    const data = zip(stems.map(({ left, right, sampleRate }, ch) => ({ name: `${fileBase()}_voice${ch + 1}.wav`, data: encodeWav(left, right, sampleRate) })));
    return { name: `${fileBase()}_stems.zip`, data, type: 'application/zip', seconds: stems[0].left.length / stems[0].sampleRate };
  });
  $('x-spc').addEventListener('click', () => {
    try {
      const { data, streamBytes, free, seconds } = buildSpc(structuredClone(song));
      download(`${fileBase()}.spc`, data as BlobPart, 'application/octet-stream');
      track('export', { format: 'spc' });
      status().textContent = t('export.spcReady', { song: kib(streamBytes), free: kib(free), seconds: num(seconds, 1) });
    } catch (err) {
      status().textContent = (err as Error).message;
    }
  });
  $('x-xm').addEventListener('click', () => {
    try {
      const { data, warnings } = encodeXm(structuredClone(song));
      download(`${fileBase()}.xm`, data as BlobPart, 'application/octet-stream');
      track('export', { format: 'xm' });
      status().textContent = t('export.size', { name: `${fileBase()}.xm`, size: kib(data.length) });
      if (warnings.length) status().textContent += ` ${t('export.approxHint', { list: warnings.join(', ') })}`;
    } catch (err) {
      status().textContent = (err as Error).message;
    }
  });
}

function renderHelpPanel() {
  const fx = ['0xy', '1xx', '2xx', '3xx', '4xy', '5xy', '6xx', '7xx', '8xx', '9xx', 'Axy', 'Bxx', 'Cxx', 'Dxx', 'Exx', 'Fxx'].map(
    (code): [string, string] => [code, t(`help.fx.${code[0]}` as MessageKey)],
  );
  const keys: [string, MessageKey][] = [
    ['Z S X D C …', 'help.key.notes'],
    ['1', 'help.key.noteOff'],
    ['0–9, A–F', 'help.key.values'],
    [t('help.keyName.arrows'), 'help.key.move'],
    ['Tab', 'help.key.channel'],
    [t('help.keyName.space'), 'help.key.play'],
    [t('help.keyName.shiftSpace'), 'help.key.loop'],
    [t('help.keyName.del'), 'help.key.clear'],
    [t('help.keyName.ins'), 'help.key.insert'],
    ['Esc', 'help.key.rec'],
    ['[ / ]', 'help.key.octave'],
    ['Ctrl+Z / Ctrl+Y', 'help.key.undo'],
    [t('help.keyName.shiftArrows'), 'help.key.select'],
    ['Ctrl+C / Ctrl+X', 'help.key.copy'],
    ['Ctrl+V', 'help.key.paste'],
    ['Ctrl+↑ / Ctrl+↓', 'help.key.transpose'],
    [t('help.keyName.save'), 'help.key.save'],
  ];
  const table = (rows: [string, string][]) =>
    `<table class="help-table">${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>`;
  panelEl.innerHTML = `
    <div class="btn-row" style="margin-top:0"><a class="btn primary" href="./manual.html" target="_blank" rel="noopener">${t('help.manual')}</a><button type="button" class="btn" id="about-open">${t('help.about')}</button></div>
    <h2>${t('help.columns')}</h2>
    <div class="legend"><span class="f0">C-4 ${t('help.col.note')}</span><span class="f1">01 ${t('help.col.instrument')}</span><span class="f2">7F ${t('help.col.volume')}</span><span class="f3">A ${t('help.col.effect')}</span><span class="f4">0F ${t('help.col.param')}</span></div>
    <h2>${t('help.keyboard')}</h2>${table(keys.map(([k, m]) => [k, t(m)]))}
    <h2>${t('help.touch')}</h2>
    <p class="hint">${t('help.touchHint')}</p>
    <h2>${t('help.effects')}</h2>${table(fx)}
    <p class="hint">${t('help.footer')}</p>`;
  $('about-open').addEventListener('click', () => {
    openAbout();
    track('about');
  });
}

function renderPanel() {
  document
    .querySelectorAll<HTMLButtonElement>('[data-tab]')
    .forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  if (tab === 'inst') renderInstrumentPanel();
  else if (tab === 'smpl') renderSamplePanel();
  else if (tab === 'song') renderSongPanel();
  else if (tab === 'file') renderFilePanel();
  else renderHelpPanel();
  renderInstList();
}

function loadSong(next: Song, id: string | null) {
  if (playing) togglePlay();
  song = next;
  songId = id;
  if (historyTimer) clearTimeout(historyTimer);
  historyTimer = 0;
  history.reset(JSON.stringify(next));
  selection = null;
  updateUndoButtons();
  dirty = false;
  order = 0;
  cursor = { row: 0, ch: 0, field: 0 };
  sampleIndex = 0;
  audio.setSong(song);
  persist(true);
  renderAll();
}

// ------------------------------------------------------------------ library

let library: SongLibrary | null = null;
let libraryPersistent = true;
let libraryList: SongMeta[] = [];
let libraryFilter = '';

function setDirty(value: boolean) {
  if (dirty === value) return;
  dirty = value;
  renderSongState();
}

/** Shows whether the working copy is saved, in the FILE tab and as a dot on the tab. */
function renderSongState() {
  document.querySelector('[data-tab="file"]')?.classList.toggle('dirty', dirty);
  const el = document.getElementById('f-state');
  if (!el) return;
  const state = !songId ? 'lib.notInLibrary' : dirty ? 'lib.unsaved' : 'lib.saved';
  el.textContent = t(state);
  el.dataset.state = state.slice(4);
}

function renderLibraryList() {
  const el = document.getElementById('lib-list');
  if (!el) return;
  const date = (msec: number) => new Date(msec).toLocaleString(getLocale(), { dateStyle: 'short', timeStyle: 'short' });
  const action = (act: string, icon: string, label: MessageKey, title: string) =>
    `<button type="button" class="lib-act" data-act="${act}" title="${escapeHtml(t(label, { title }))}" aria-label="${escapeHtml(t(label, { title }))}">${icon}</button>`;
  const filter = libraryFilter.trim().toLowerCase();
  const list = filter ? libraryList.filter((m) => `${m.title} ${m.author}`.toLowerCase().includes(filter)) : libraryList;
  el.innerHTML = list.length
    ? list
        .map((m) => {
          const title = m.title || t('lib.untitled');
          const info = [m.author, `${m.bpm} BPM`, t('lib.patterns', { count: m.patterns }), date(m.updated)]
            .filter(Boolean)
            .map((x) => escapeHtml(String(x)))
            .join(' · ');
          const current = m.id === songId;
          return `<div class="lib-row" data-id="${m.id}" aria-current="${current}">
            <button type="button" class="lib-open" data-act="open" title="${escapeHtml(t('lib.open', { title }))}"><span class="lib-title">${escapeHtml(title)}</span><span class="lib-info">${info}</span></button>
            ${action('rename', '✎', 'lib.rename', title)}${action('duplicate', '⧉', 'lib.duplicate', title)}${current ? '<span class="lib-act" aria-hidden="true"></span>' : action('sounds', '♫', 'lib.sounds', title)}${action('delete', '✕', 'lib.delete', title)}
          </div>`;
        })
        .join('')
    : `<p class="hint">${t(!library ? 'lib.loading' : filter ? 'lib.noMatch' : 'lib.empty')}</p>`;
}

async function refreshLibrary() {
  if (!library) return;
  libraryList = await library.list();
  if (tab === 'file') renderPanel();
}

/** True when nothing unsaved would be lost, or the user agrees to lose it. */
function confirmDiscard() {
  return !dirty || confirm(t('lib.confirmDiscard', { title: song.title || t('lib.untitled') }));
}

async function saveToLibrary(asCopy = false) {
  if (!library) return;
  try {
    const meta = await library.save(structuredClone(song), asCopy ? undefined : (songId ?? undefined));
    songId = meta.id;
    dirty = false;
    persist(true);
    track(asCopy ? 'song-save-as' : 'song-save');
    toast(t('lib.savedToast', { title: meta.title || t('lib.untitled') }));
  } catch (err) {
    toast(t('lib.error', { error: (err as Error).message }));
  }
  renderSongState();
  await refreshLibrary();
}

async function libraryAction(act: string, id: string) {
  if (!library) return;
  const meta = libraryList.find((m) => m.id === id);
  if (!meta) return;
  const title = meta.title || t('lib.untitled');
  try {
    if (act === 'open') {
      if (id === songId && !dirty) return;
      if (!confirmDiscard()) return;
      const next = await library.load(id);
      if (next) loadSong(next, id);
      toast(t('file.loaded', { title }));
    } else if (act === 'rename') {
      const name = prompt(t('lib.renamePrompt'), meta.title);
      if (name === null || !name.trim()) return;
      await library.rename(id, name.trim());
      if (id === songId) {
        song.title = name.trim();
        persist(true);
        renderAll();
      }
    } else if (act === 'duplicate') {
      await library.duplicate(id, t('lib.copySuffix'));
    } else if (act === 'sounds') {
      if (!confirm(t('lib.confirmSounds', { title }))) return;
      const source = await library.load(id);
      if (!source) return;
      copySounds(song, source);
      changed(true);
      toast(t('lib.soundsToast', { title }));
    } else if (act === 'delete') {
      if (!confirm(t('lib.confirmDelete', { title }))) return;
      await library.remove(id);
      if (id === songId) {
        songId = null;
        dirty = true;
        persist(true);
        renderSongState();
      }
    } else {
      return;
    }
    track('library', { action: act });
  } catch (err) {
    toast(t('lib.error', { error: (err as Error).message }));
  }
  await refreshLibrary();
}

/** Adds song files and library backups (.zip) to the library; a single song is also opened. */
async function importFiles(files: File[]) {
  if (!library) return;
  const songs: Song[] = [];
  const failed: string[] = [];
  for (const file of files) {
    try {
      if (/\.zip$/i.test(file.name)) {
        const dec = new TextDecoder();
        for (const entry of unzip(new Uint8Array(await file.arrayBuffer()))) {
          if (!/\.json$/i.test(entry.name)) continue;
          const text = typeof entry.data === 'string' ? entry.data : dec.decode(entry.data);
          songs.push(parseSong(JSON.parse(text)));
        }
      } else {
        songs.push(parseSong(JSON.parse(await file.text())));
      }
    } catch (err) {
      failed.push(`${file.name}: ${(err as Error).message}`);
    }
  }
  if (failed.length) toast(t('file.loadError', { error: failed.join(', ') }));
  track('import', { files: files.length, songs: songs.length, failed: failed.length });
  if (!songs.length) return;
  const single = songs.length === 1 && files.length === 1 && !/\.zip$/i.test(files[0].name);
  if (single && !confirmDiscard()) return;
  try {
    const metas = [];
    for (const s of songs) metas.push(await library.save(s));
    if (single) {
      loadSong(songs[0], metas[0].id);
      toast(t('file.loaded', { title: songs[0].title }));
    } else if (!failed.length) {
      toast(t('lib.imported', { count: songs.length }));
    }
  } catch (err) {
    toast(t('lib.error', { error: (err as Error).message }));
  }
  await refreshLibrary();
}

/** Downloads every library song as a .snes.json file in one ZIP. */
async function backupLibrary() {
  if (!library) return;
  if (!libraryList.length) {
    toast(t('lib.empty'));
    return;
  }
  const songs = (await Promise.all(libraryList.map((m) => library!.load(m.id)))).filter((s): s is Song => !!s);
  const names = uniqueNames(songs.map((s) => fileName(s.title)));
  const data = zip(songs.map((s, i) => ({ name: `${names[i]}.snes.json`, data: JSON.stringify(s) })));
  download(`snes-tracker-library-${new Date().toISOString().slice(0, 10)}.zip`, data as BlobPart, 'application/zip');
  track('library', { action: 'backup', songs: songs.length });
}

void (async () => {
  const opened = await openStore();
  library = new SongLibrary(opened.store);
  libraryPersistent = opened.persistent;
  libraryList = await library.list();
  if (songId && !libraryList.some((m) => m.id === songId)) {
    // Its entry was deleted (in another tab, say): the working copy is not in the library any more.
    songId = null;
    dirty = true;
    persist(true);
  }
  renderSongState();
  if ((tab as string) === 'file') renderPanel();
})().catch((err) => toast(t('lib.error', { error: (err as Error).message })));

function renderAll() {
  if (order >= song.order.length) order = song.order.length - 1;
  renderChannelHead();
  renderMobileNav();
  renderHeader();
  renderPattern();
  renderKeypad();
  renderPanel();
}

renderAll();

// The installed app (PWA): the service worker keeps the whole site for offline use.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  const sw = navigator.serviceWorker;
  const firstInstall = !sw.controller;
  sw.addEventListener('controllerchange', () => toast(t(firstInstall ? 'pwa.offline' : 'pwa.updated')));
  addEventListener('load', () => sw.register('./sw.js').catch(() => {}));
}
addEventListener('appinstalled', () => track('pwa-install'));
if (matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone) {
  addEventListener('load', () => track('pwa-launch'));
}

// Used by the smoke tests and handy in the console.
Object.assign(window, { snesTracker: { get song() { return song; }, DSP_RATE, VOICE_COUNT, noteName } });
