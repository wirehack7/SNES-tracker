/**
 * Browser smoke test of the built site:
 *
 *   npm run build && npm run smoke -- [screenshot-dir] [--chromium | --firefox | --webkit]
 *
 * Serves dist/ and checks, in headless Chromium (default), Firefox or WebKit:
 *
 * - at desktop, laptop, tablet and phone sizes (in WebKit: emulated iPhones and an iPad) the
 *   tracker loads without errors and without sideways scrolling, Play starts and Stop stops,
 *   and on phones the bottom bar switches between the pattern, list and editor views;
 * - typing notes on the computer keyboard and tapping the on-screen piano and keypad change the song,
 *   and the song survives a reload (localStorage);
 * - undo/redo, block selection (keys and mouse), copy/paste and transpose change the pattern as expected;
 * - the instrument panel switches between ADSR and GAIN, its settings are saved, and it fits a phone;
 * - the song library saves (button and Ctrl+S), saves as, renames, duplicates, deletes and opens songs,
 *   keeps them across a reload (IndexedDB), and its ZIP backup imports again;
 * - every export (song JSON, SPC, WAV, MP3, stems, XM) hands over a file with the right header;
 * - the MP4 export hands over an MP4 file (checked with ffprobe when installed), or says that the
 *   browser lacks WebCodecs;
 * - audio imports as a BRR sample, the waveform and drum synths add samples, and they go into the SPC;
 * - the theme button cycles auto, light and dark;
 * - the About dialog shows version and links and its keys stay out of the tracker;
 * - a German browser gets the German UI, still without sideways scrolling;
 * - the manual page loads its sections, contents list and images on desktop and phone;
 * - the scope traces stay centred while playing (Chromium) and the piano keys keep their size at every octave;
 * - on phones with 3 device pixels per CSS pixel the scopes sit above their pattern columns and keep their size;
 * - the installed app (PWA): its manifest loads, and after one visit the tracker and the manual open offline (Chromium).
 *
 * Headless Firefox and WebKit on CI have no sound device and their audio clock may never run,
 * so the check that the play cursor moves through the rows runs in Chromium only.
 * Screenshots go to the given folder.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, devices, firefox, webkit } from 'playwright';
import { serveDist } from './serve-dist.mjs';

const root = new URL('../dist/', import.meta.url).pathname;
const args = process.argv.slice(2);
const engine = args.includes('--firefox') ? 'firefox' : args.includes('--webkit') ? 'webkit' : 'chromium';
const shots = args.find((arg) => !arg.startsWith('--'));
if (shots) mkdirSync(shots, { recursive: true });

const { base, server } = await serveDist(root);

const browser =
  engine === 'firefox'
    ? await firefox.launch({ firefoxUserPrefs: { 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0 } })
    : engine === 'webkit'
      ? await webkit.launch()
      : await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
console.log(`browser: ${engine} ${browser.version()}`);

/** Context options per screen. WebKit gets real device profiles (iOS user agent, touch, DPR). */
const screens =
  engine === 'webkit'
    ? [
        { name: 'iphone-15', ...devices['iPhone 15'] },
        { name: 'iphone-se', ...devices['iPhone SE'] },
        { name: 'iphone-15-landscape', ...devices['iPhone 15 landscape'] },
        { name: 'ipad-mini', ...devices['iPad Mini'] },
        { name: 'desktop-safari', viewport: { width: 1440, height: 900 } },
      ]
    : [
        { name: 'desktop', viewport: { width: 1440, height: 900 } },
        { name: 'laptop', viewport: { width: 1280, height: 720 } },
        { name: 'tablet', viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true },
        { name: 'phone', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
        { name: 'phone-landscape', viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true },
        { name: 'small-phone', viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true },
        { name: 'short-phone-landscape', viewport: { width: 734, height: 343 }, hasTouch: true, isMobile: true },
      ];

const failures = [];

async function open(screen, { locale = 'en-US', path = '', ready = '#pattern .prow' } = {}) {
  const { name, defaultBrowserType, ...options } = screen;
  // Firefox has no mobile emulation; touch and the small viewport still apply.
  if (engine === 'firefox') delete options.isMobile;
  const context = await browser.newContext({ locale, serviceWorkers: 'block', acceptDownloads: true, ...options });
  // Without this, an action that never completes (such as a tap) waits forever.
  context.setDefaultTimeout(15000);
  const page = await context.newPage();
  const errors = [];
  // Firefox rejects the old page's pending promises with this when it reloads; that is not a bug.
  const unload = /Navigated away from page/;
  page.on('pageerror', (e) => unload.test(e.message) || errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !unload.test(m.text()) && errors.push(m.text()));
  await page.goto(base + path, { waitUntil: 'load' });
  await page.waitForSelector(ready);
  return { context, page, errors };
}

/** Rejects when `promise` takes longer than `ms`: a hung browser call must fail, not stall CI. */
function within(ms, promise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`took longer than ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function check(name, run) {
  try {
    await within(180000, run());
    console.log(`ok   ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Clicks or taps, whichever the screen uses. */
async function press(page, locator, touch) {
  if (touch) await locator.tap();
  else await locator.click();
}

/** The song as the app keeps it in localStorage (saved 400 ms after a change). */
async function storedSong(page) {
  await page.waitForTimeout(600);
  return page.evaluate(() => localStorage.getItem('snes-tracker.song'));
}

for (const screen of screens) {
  const touch = !!screen.hasTouch;
  const phone = (screen.viewport?.width ?? 0) < 760;

  await check(`${screen.name}: loads, fits the screen, plays and stops`, async () => {
    const { context, page, errors } = await open(screen);
    try {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert(overflow <= 1, `page scrolls sideways by ${overflow}px`);
      assert((await page.locator('#pattern .prow').count()) > 0, 'the pattern shows no rows');

      const play = page.locator('#play-song');
      await press(page, play, touch);
      await page.waitForFunction(() => document.querySelector('#play-song')?.getAttribute('aria-pressed') === 'true');
      assert(await page.locator('#play-led.on').isVisible(), 'the play LED did not light up');
      if (engine === 'chromium') {
        // The worklet reports each row it plays; the play cursor must reach a later row.
        await page.waitForFunction(() => Number(document.querySelector('.play-row')?.dataset.row ?? 0) > 2, null, { timeout: 10000 });
        // The scope traces stay centred while playing.
        const off = await page.evaluate(() =>
          [...document.querySelectorAll('#chan-head canvas')].map((c) => {
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            let top = c.height;
            let bottom = -1;
            for (let i = 3; i < d.length; i += 4)
              if (d[i] > 100) {
                const y = Math.floor((i - 3) / 4 / c.width);
                top = Math.min(top, y);
                bottom = Math.max(bottom, y);
              }
            return bottom < 0 ? 1 : Math.abs((top + bottom) / 2 / c.height - 0.5);
          }),
        );
        assert(off.every((o) => o < 0.2), `scope traces are off-centre by ${off.map((o) => o.toFixed(2)).join(' ')}`);
      } else {
        await page.waitForTimeout(500);
      }
      if (shots) await page.screenshot({ path: join(shots, `${engine}-${screen.name}.png`) });
      await press(page, page.locator('#stop'), touch);
      await page.waitForFunction(() => document.querySelector('#play-song')?.getAttribute('aria-pressed') === 'false');
      assert(!(await page.locator('#play-led.on').count()), 'the play LED stayed on after Stop');
      assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
    } finally {
      await context.close();
    }
  });

  await check(`${screen.name}: piano keys keep their size at every octave`, async () => {
    const { context, page, errors } = await open(screen);
    try {
      const width = () => page.locator('#piano .pkey.white').first().evaluate((el) => el.getBoundingClientRect().width);
      const first = await width();
      for (let i = 0; i < 7; i++) {
        await page.keyboard.press(']');
        const w = await width();
        assert(Math.abs(w - first) < 1, `white keys are ${w.toFixed(1)}px at octave ${await page.textContent('#oct')}, ${first.toFixed(1)}px before`);
      }
      assert((await page.textContent('#oct')) === '7', '] did not raise the octave to 7');
      assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
    } finally {
      await context.close();
    }
  });

  if (phone) {
    await check(`${screen.name}: bottom bar switches views`, async () => {
      const { context, page, errors } = await open(screen);
      try {
        const nav = page.locator('.mobile-nav');
        assert(await nav.isVisible(), 'the bottom bar is not shown on a phone');
        const views = [
          ['lists', '.sidebar.left'],
          ['edit', '.sidebar.right'],
          ['pattern', '.editor'],
        ];
        for (const [view, selector] of views) {
          await press(page, nav.locator(`[data-view="${view}"]`), touch);
          assert(await page.locator(selector).isVisible(), `${view}: ${selector} is not shown`);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          assert(overflow <= 1, `${view}: page scrolls sideways by ${overflow}px`);
          if (shots) await page.screenshot({ path: join(shots, `${engine}-${screen.name}-${view}.png`) });
        }
        assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
      } finally {
        await context.close();
      }
    });
  }

  if (touch) {
    await check(`${screen.name}: piano and keypad enter notes`, async () => {
      const { context, page, errors } = await open(screen);
      try {
        // The keypad comes with a coarse pointer or a narrow screen. Firefox has no mobile
        // emulation, so a wide touch screen there reports a fine pointer and shows no keypad.
        if (!(await page.evaluate(() => matchMedia('(pointer: coarse), (max-width: 759px)').matches))) {
          assert(engine === 'firefox', 'a touch screen reports a fine pointer');
          console.log(`skip ${screen.name}: Firefox reports a fine pointer at this width`);
          return;
        }
        const note = () => page.locator('#pattern .prow[data-row="0"] [data-ch="0"][data-f="0"]').textContent();
        // Put the cursor on row 00, channel 1, note field, clear it, then play E on the piano
        // and enter a note-off from the keypad.
        await press(page, page.locator('#pattern .prow[data-row="0"] [data-ch="0"][data-f="0"]'), touch);
        assert(await page.locator('#piano').isVisible(), 'the piano is not shown');
        assert(await page.locator('#keypad').isVisible(), 'the keypad is not shown');
        const rows = await page.locator('#pattern').evaluate((el) => el.clientHeight);
        assert(rows >= 64, `the piano and keypad leave the pattern only ${rows}px`);
        await press(page, page.locator('#keypad [data-act="del"]'), touch);
        await press(page, page.locator('#keypad [data-act="up"]'), touch);
        assert((await note()) === '···', `row 00 still shows ${await note()} after DEL`);
        // The third white key from the left is an E.
        await press(page, page.locator('#piano .pkey.white').nth(2), touch);
        assert(/^E-\d$/.test(await note()), `tapping E on the piano wrote ${await note()}`);
        await press(page, page.locator('#keypad [data-act="up"]'), touch);
        await press(page, page.locator('#keypad [data-act="off"]'), touch);
        assert((await note()) === '===', `tapping OFF wrote ${await note()}`);

        // With the piano hidden the keypad has note keys instead.
        await press(page, page.locator('#piano-toggle'), touch);
        assert(await page.locator('#piano').isHidden(), 'KEYS did not hide the piano');
        await press(page, page.locator('#keypad [data-act="up"]'), touch);
        await press(page, page.locator('#keypad [data-semi="7"]'), touch);
        assert(/^G-\d$/.test(await note()), `tapping G on the keypad wrote ${await note()}`);
        assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
      } finally {
        await context.close();
      }
    });
  }
}

const desktop = screens.find((s) => !s.hasTouch);

await check('scopes sit above their pattern columns on high-density phones', async () => {
  // Phones draw at 2-3 device pixels per CSS pixel; the scopes' drawing buffers must not widen the header.
  // The pattern scrolls sideways on phones, so only the voices in view are compared.
  for (const screen of screens.filter((s) => s.hasTouch)) {
    const { context, page, errors } = await open({ ...screen, deviceScaleFactor: screen.deviceScaleFactor ?? 3 });
    try {
      const layout = () =>
        page.evaluate(() => {
          const left = (e) => Math.round(e.getBoundingClientRect().left);
          const row = document.querySelector('#pattern .prow');
          return {
            heads: [...document.querySelectorAll('#chan-head .chan')].map(left),
            columns: [0, 1, 2, 3, 4, 5, 6, 7].map((ch) => {
              const field = row.querySelector(`[data-ch="${ch}"]`);
              return field ? left(field.closest('.cell') ?? field) : null;
            }),
            buffers: [...document.querySelectorAll('#chan-head canvas')].map((c) => [c.width, c.clientWidth]),
            dpr: devicePixelRatio,
          };
        });
      await page.waitForTimeout(300);
      const first = await layout();
      await page.waitForTimeout(700);
      const later = await layout();
      assert(later.heads.length === 8, `${screen.name}: ${later.heads.length} scopes`);
      assert(
        later.heads.every((x, i) => later.columns[i] === null || Math.abs(x - later.columns[i]) <= 2),
        `${screen.name}: scopes at ${later.heads.join(' ')}, columns at ${later.columns.join(' ')}`,
      );
      assert(
        later.buffers.every(([w, css]) => css > 20 && w <= Math.ceil(css * later.dpr) + 1),
        `${screen.name}: scope buffers ${later.buffers.map((b) => b.join('/')).join(' ')} at ${later.dpr}x`,
      );
      assert(JSON.stringify(first) === JSON.stringify(later), `${screen.name}: the header keeps changing size`);
      assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
    } finally {
      await context.close();
    }
  }
});

await check('keyboard note entry is saved and survives a reload', async () => {
  const { context, page, errors } = await open(desktop);
  try {
    // Start from an empty song so the test does not depend on the demo.
    await page.locator('.tabs [data-tab="file"]').click();
    await page.locator('#f-new').click();
    await page.waitForTimeout(100);
    const empty = await storedSong(page);
    await page.locator('#pattern .prow[data-row="0"] [data-ch="0"][data-f="0"]').click();
    // Z, S, X are C, C#, D in the lower keyboard octave.
    for (const k of ['KeyZ', 'KeyS', 'KeyX']) await page.keyboard.press(k);
    const cells = await page.$$eval('#pattern .prow', (rows) => rows.slice(0, 3).map((r) => r.querySelector('.f0')?.textContent));
    assert(cells.every((t) => /^[A-G][-#]\d$/.test(t ?? '')), `rows 00-02 show ${cells.join(', ')}, expected three notes`);
    const saved = await storedSong(page);
    assert(saved && saved !== empty, 'the typed notes were not saved');
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#pattern .prow');
    const reloaded = await page.$$eval('#pattern .prow', (rows) => rows.slice(0, 3).map((r) => r.querySelector('.f0')?.textContent));
    assert(reloaded.join() === cells.join(), `after a reload rows 00-02 show ${reloaded.join(', ')}`);
    assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
  } finally {
    await context.close();
  }
});

await check('undo/redo, block selection, copy/paste and transpose', async () => {
  const { context, page, errors } = await open(desktop);
  try {
    await page.locator('.tabs [data-tab="file"]').click();
    await page.locator('#f-new').click();
    await page.waitForTimeout(100);
    const col = (ch) =>
      page.$$eval('#pattern .prow', (rows, c) => rows.slice(0, 4).map((r) => r.querySelector(`[data-ch="${c}"][data-f="0"]`)?.textContent), ch);
    await page.locator('#pattern .prow[data-row="0"] [data-ch="0"][data-f="0"]').click();
    for (const k of ['KeyZ', 'KeyX', 'KeyC', 'KeyV']) await page.keyboard.press(k); // C D E F
    const typed = await col(0);
    assert(/^C-/.test(typed[0]) && /^F-/.test(typed[3]), `typed ${typed.join(' ')}`);
    assert(await page.locator('#undo').isEnabled(), 'the undo button is disabled after an edit');

    // Ctrl+Z takes the whole burst of typing back, Ctrl+Y brings it again.
    await page.keyboard.press('Control+KeyZ');
    assert((await col(0)).every((t) => t === '···'), `after undo: ${(await col(0)).join(' ')}`);
    await page.keyboard.press('Control+KeyY');
    assert((await col(0)).join() === typed.join(), `after redo: ${(await col(0)).join(' ')}`);

    // Select rows 00-03 of channel 1 with Shift+arrows, copy, paste into channel 2.
    await page.locator('#pattern .prow[data-row="0"] [data-ch="0"][data-f="0"]').click();
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowDown');
    assert((await page.locator('#pattern .cell.sel').count()) === 4, 'Shift+Down did not select 4 cells');
    await page.keyboard.press('Control+KeyC');
    await page.locator('#pattern .prow[data-row="0"] [data-ch="1"][data-f="0"]').click();
    assert((await page.locator('#pattern .cell.sel').count()) === 0, 'a click did not clear the selection');
    await page.keyboard.press('Control+KeyV');
    assert((await col(1)).join() === typed.join(), `pasted: ${(await col(1)).join(' ')}`);

    // The pasted block stays selected: transpose it up an octave.
    await page.keyboard.press('Control+Shift+ArrowUp');
    const up = await col(1);
    assert(up.every((t, i) => t.slice(0, 2) === typed[i].slice(0, 2) && Number(t[2]) === Number(typed[i][2]) + 1), `transposed: ${up.join(' ')}`);
    assert((await col(0)).join() === typed.join(), 'transposing changed channel 1 too');

    // Mouse drag selects a block; Delete clears it.
    const from = await page.locator('#pattern .prow[data-row="0"] [data-ch="0"][data-f="0"]').boundingBox();
    const to = await page.locator('#pattern .prow[data-row="1"] [data-ch="1"][data-f="0"]').boundingBox();
    await page.mouse.move(from.x + 4, from.y + 4);
    await page.mouse.down();
    await page.mouse.move(to.x + 4, to.y + 4, { steps: 4 });
    await page.mouse.up();
    assert((await page.locator('#pattern .cell.sel').count()) === 4, 'dragging did not select 2 × 2 cells');
    await page.keyboard.press('Delete');
    assert((await col(0)).slice(0, 2).every((t) => t === '···') && (await col(1))[2] !== '···', 'Delete did not clear just the block');
    assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
  } finally {
    await context.close();
  }
});

await check('instrument envelope: ADSR and GAIN, saved, fits a phone', async () => {
  const phoneScreen = screens.find((s) => s.hasTouch && (s.viewport?.width ?? 0) < 760);
  for (const screen of [desktop, phoneScreen].filter(Boolean)) {
    const { context, page, errors } = await open(screen);
    try {
      if (screen.hasTouch) await page.locator('.mobile-nav [data-view="edit"]').tap();
      await page.locator('.tabs [data-tab="inst"]').click();
      await page.locator('#i-a').evaluate((el) => {
        el.value = '8';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      let saved = JSON.parse(await storedSong(page));
      assert(saved.instruments[0].adsr.attack === 8, `${screen.name}: attack saved as ${saved.instruments[0].adsr.attack}`);
      assert(await page.locator('#env-canvas').isVisible(), `${screen.name}: no envelope graph`);
      await page.locator('[data-env="gain"]').click();
      await page.locator('#i-gm').selectOption('linDown');
      await page.locator('#i-echo').check();
      saved = JSON.parse(await storedSong(page));
      const ins = saved.instruments[0];
      assert(ins.envelope === 'gain' && (ins.gain & 0xe0) === 0x80 && ins.echo === true, `${screen.name}: saved ${JSON.stringify(ins)}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert(overflow <= 1, `${screen.name}: the instrument panel scrolls sideways by ${overflow}px`);
      if (shots) await page.screenshot({ path: join(shots, `${engine}-${screen.name}-instrument.png`) });
      assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
    } finally {
      await context.close();
    }
  }
});

await check('song library saves, renames, duplicates, deletes and backs up songs', async () => {
  const { context, page, errors } = await open(desktop);
  try {
    const rows = () => page.locator('#lib-list .lib-row');
    const titles = () => page.$$eval('#lib-list .lib-title', (els) => els.map((e) => e.textContent).sort());
    const state = () => page.locator('#f-state').getAttribute('data-state');
    const row = (title) => rows().filter({ has: page.locator('.lib-title', { hasText: new RegExp(`^${title}$`) }) });
    const answer = (text) => page.once('dialog', (d) => d.accept(text));

    await page.locator('.tabs [data-tab="file"]').click();
    await page.waitForSelector('#lib-list .hint, #lib-list .lib-row');
    assert((await state()) === 'notInLibrary', `a fresh demo is ${await state()}`);
    await page.locator('#f-store').click();
    await rows().first().waitFor();
    assert((await state()) === 'saved', `after Save the song is ${await state()}`);

    // Editing marks the song unsaved; Ctrl+S saves it again.
    await page.locator('.tabs [data-tab="song"]').click();
    await page.locator('#s-title').fill('Smoke song');
    assert(await page.locator('.tabs [data-tab="file"].dirty').count(), 'the FILE tab shows no unsaved dot');
    await page.locator('#pattern').focus();
    await page.keyboard.press('Control+s');
    await page.locator('.tabs [data-tab="file"]:not(.dirty)').waitFor();
    await page.locator('.tabs [data-tab="file"]').click();
    assert((await titles()).join() === 'Smoke song', `library holds ${(await titles()).join(', ')}`);

    answer('Second');
    await page.locator('#f-saveas').click();
    await rows().nth(1).waitFor();
    assert((await row('Second').getAttribute('aria-current')) === 'true', 'Save as did not switch to the copy');

    answer('Renamed');
    await row('Smoke song').locator('[data-act="rename"]').click();
    await row('Renamed').waitFor();
    await row('Renamed').locator('[data-act="duplicate"]').click();
    await row('Renamed \\(copy\\)').waitFor();
    answer();
    await row('Renamed \\(copy\\)').locator('[data-act="delete"]').click();
    await row('Renamed \\(copy\\)').waitFor({ state: 'detached' });
    assert((await titles()).join() === 'Renamed,Second', `library holds ${(await titles()).join(', ')}`);

    // The library and the open song survive a reload.
    await page.reload({ waitUntil: 'load' });
    await page.locator('.tabs [data-tab="file"]').click();
    await rows().nth(1).waitFor();
    assert((await row('Second').getAttribute('aria-current')) === 'true', 'after a reload Second is not open');
    assert((await state()) === 'saved', `after a reload the song is ${await state()}`);
    await row('Renamed').locator('.lib-open').click();
    await page.locator('.current-song strong', { hasText: 'Renamed' }).waitFor();

    const backup = await download(page, 'f-backup');
    assert(/\.zip$/.test(backup.name) && backup.bytes.subarray(0, 2).toString('latin1') === 'PK', `backup is ${backup.name}`);
    assert(backup.bytes.includes('Renamed.snes.json') && backup.bytes.includes('Second.snes.json'), 'backup misses songs');
    await page.locator('#f-input').setInputFiles({ name: backup.name, mimeType: 'application/zip', buffer: backup.bytes });
    await rows().nth(3).waitFor();
    assert((await titles()).join() === 'Renamed,Renamed,Second,Second', `after import: ${(await titles()).join(', ')}`);
    assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
  } finally {
    await context.close();
  }
});

async function download(page, id, timeout = 20000) {
  const pending = page.waitForEvent('download', { timeout });
  await page.locator(`#${id}`).click();
  const file = await pending;
  const failure = await file.failure();
  assert(!failure, `${id}: download failed: ${failure}`);
  const chunks = [];
  for await (const chunk of await file.createReadStream()) chunks.push(chunk);
  return { name: file.suggestedFilename(), bytes: Buffer.concat(chunks) };
}

const SPC_ID = 'SNES-SPC700 Sound File Data v0.30';
const exports = [
  ['f-save', /\.snes\.json$/, (b) => typeof JSON.parse(b.toString('utf8')).patterns === 'object'],
  ['x-spc', /\.spc$/, (b) => b.subarray(0, 33).toString('latin1') === SPC_ID && b.length === 0x10200],
  ['x-wav', /\.wav$/, (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE' && b.length > 10000],
  // An MP3 starts with an ID3 tag or a frame sync.
  ['x-mp3', /\.mp3$/, (b) => (b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) && b.length > 20000],
  ['x-stems', /_stems\.zip$/, (b) => b.subarray(0, 2).toString('latin1') === 'PK' && b.includes('_voice8.wav')],
  ['x-xm', /\.xm$/, (b) => b.subarray(0, 17).toString('latin1') === 'Extended Module: '],
];

/** ffprobe's view of a file, or null without ffprobe. */
function probe(bytes, name) {
  try {
    const file = join(mkdtempSync(join(tmpdir(), 'smoke-')), name);
    writeFileSync(file, bytes);
    return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

await check('MP4 export (WebCodecs) or a clear message without it', async () => {
  const { context, page, errors } = await open(desktop);
  try {
    await page.locator('.tabs [data-tab="file"]').click();
    const supported = await page.evaluate(() => typeof AudioEncoder !== 'undefined' && typeof VideoEncoder !== 'undefined');
    if (!supported) {
      assert(engine !== 'chromium', 'Chromium has no WebCodecs encoders');
      await page.locator('#x-mp4').click();
      await page.waitForFunction(() => /WebCodecs/.test(document.querySelector('#x-status')?.textContent ?? ''));
      console.log(`skip ${engine}: no WebCodecs encoders, the status line says so`);
      return;
    }
    const video = await download(page, 'x-mp4', 300000);
    assert(/\.mp4$/.test(video.name), `x-mp4: file is called ${video.name}`);
    assert(video.bytes.subarray(4, 8).toString('latin1') === 'ftyp', 'x-mp4: not an MP4 file');
    const info = probe(video.bytes, video.name);
    if (info) {
      const video0 = info.streams.find((st) => st.codec_type === 'video');
      const audio0 = info.streams.find((st) => st.codec_type === 'audio');
      assert(video0 && audio0, `x-mp4: streams are ${info.streams.map((st) => st.codec_name).join(',')}`);
      assert(video0.width === 1280 && video0.height === 720, 'x-mp4: not 1280x720');
      assert(Number(info.format.duration) > 5, `x-mp4: lasts ${info.format.duration} s`);
    }
    assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
  } finally {
    await context.close();
  }
});

await check('every export hands over a valid file', async () => {
  const { context, page, errors } = await open(desktop);
  try {
    await page.locator('.tabs [data-tab="file"]').click();
    for (const [id, name, valid] of exports) {
      const file = await download(page, id, 120000);
      assert(name.test(file.name), `${id}: file is called ${file.name}`);
      assert(valid(file.bytes), `${id}: ${file.name} (${file.bytes.length} bytes) has a wrong header`);
    }
    assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
  } finally {
    await context.close();
  }
});

/** A mono 16-bit WAV file of `seconds` of `fn(t)` (t in seconds). */
function wavFile(name, seconds, fn, rate = 22050) {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8, 'latin1');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1');
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(20000 * fn(i / rate)), 44 + i * 2);
  return { name, mimeType: 'audio/wav', buffer: b };
}

await check('audio imports as a sample, the synths add samples, and they go into the SPC', async () => {
  const { context, page, errors } = await open(desktop);
  try {
    await page.locator('.tabs [data-tab="file"]').click();
    await page.locator('#f-new').click();
    await page.locator('.tabs [data-tab="smpl"]').click();
    const before = JSON.parse(await storedSong(page)).samples.length;
    await page.selectOption('#s-rate', '16000');
    await page.setInputFiles('#s-file', wavFile('kick.wav', 0.3, (t) => Math.exp(-t * 15) * Math.sin(2 * Math.PI * (60 + 200 * Math.exp(-t * 40)) * t)));
    await page.waitForSelector(`[data-splay="${before}"]`);
    await page.locator(`[data-splay="${before}"]`).click();
    let song = JSON.parse(await storedSong(page));
    const kick = song.samples[before];
    assert(kick?.name === 'kick' && kick.rate === 16000, `imported ${JSON.stringify(kick && { name: kick.name, rate: kick.rate })}`);
    // 0.3 s at 16 kHz in 9-byte BRR blocks of 16 samples.
    const bytes = Buffer.from(kick.brr, 'base64').length;
    assert(Math.abs(bytes - (0.3 * 16000 * 9) / 16) < 100, `the kick has ${bytes} BRR bytes`);
    // A synthesized saw wave and a snare.
    await page.locator('[data-shape="saw"]').click();
    await page.locator('#w-add').click();
    await page.selectOption('#d-kind', 'snare');
    await page.locator('#d-add').click();
    song = JSON.parse(await storedSong(page));
    assert(song.samples.length === before + 3, `${song.samples.length - before} samples added`);
    assert(song.samples[before + 1].loop === 0, 'the synthesized wave does not loop');
    if (shots) await page.screenshot({ path: join(shots, `${engine}-samples.png`) });
    // An instrument plays the kick; the SPC holds its BRR data.
    await page.locator('#s-inst').click();
    await page.locator('.tabs [data-tab="file"]').click();
    const spc = await download(page, 'x-spc', 120000);
    assert(spc.bytes.includes(Buffer.from(kick.brr, 'base64')), 'the SPC does not hold the imported sample');
    assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
  } finally {
    await context.close();
  }
});

await check('theme button cycles auto, light and dark', async () => {
  const { context, page, errors } = await open(desktop);
  try {
    const theme = () => page.evaluate(() => document.documentElement.dataset.theme ?? 'auto');
    const seen = [await theme()];
    for (let i = 0; i < 3; i++) {
      await page.locator('#theme').click();
      seen.push(await theme());
    }
    assert(seen.join() === 'auto,light,dark,auto', `theme went ${seen.join(' → ')}`);
    assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
  } finally {
    await context.close();
  }
});

const phone = screens.find((s) => s.hasTouch && (s.viewport?.width ?? 0) < 760);

await check('About dialog opens and its keys stay out of the tracker', async () => {
  for (const screen of [desktop, phone]) {
    const touch = !!screen.hasTouch;
    const { context, page, errors } = await open(screen);
    try {
      if (touch) await press(page, page.locator('.mobile-nav [data-view="edit"]'), touch);
      await press(page, page.locator('.tabs [data-tab="help"]'), touch);
      const rec = await page.locator('#rec').getAttribute('aria-pressed');
      await press(page, page.locator('#about-open'), touch);
      const dialog = page.locator('dialog#about');
      await dialog.waitFor({ state: 'visible' });
      assert(/^Version \d+\.\d+\.\d+/.test(await page.locator('#about-version').textContent()), 'no version shown');
      assert((await page.locator('#about-repo').getAttribute('href')).includes('github.com/wirehack7/SNES-tracker'), 'no repo link');
      assert((await page.locator('#about-manual').getAttribute('href')) === './manual.html', 'no manual link');
      const box = await dialog.boundingBox();
      const width = page.viewportSize().width;
      assert(box.x >= 0 && box.x + box.width <= width + 1, `${screen.name}: the dialog does not fit (${box.width}px)`);
      // Space must not start the song behind the dialog. (On the close button it would
      // press that button, as in any dialog, so the test takes the focus off it first.)
      if (!touch) {
        await page.evaluate(() => document.activeElement?.blur());
        await page.keyboard.press('Space');
        await page.waitForTimeout(200);
        assert((await page.locator('#play-song').getAttribute('aria-pressed')) !== 'true', 'Space in the dialog started the song');
      }
      if (shots) await page.screenshot({ path: join(shots, `${engine}-${screen.name}-about.png`) });
      // Esc closes the dialog and must not toggle record mode in the tracker.
      if (touch) await press(page, page.locator('#about-close'), touch);
      else await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      assert((await page.locator('#rec').getAttribute('aria-pressed')) === rec, 'closing the dialog toggled record mode');
      assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
    } finally {
      await context.close();
    }
  }
});

for (const [locale, lang] of [['de-DE', 'de']]) {
  await check(`${locale} browser gets the ${lang} UI and it fits a phone`, async () => {
    for (const screen of [desktop, phone]) {
      const { context, page, errors } = await open(screen, { locale });
      try {
        const got = await page.evaluate(() => document.documentElement.lang);
        assert(got === lang, `${screen.name}: page language is ${got}`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert(overflow <= 1, `${screen.name}: page scrolls sideways by ${overflow}px`);
        if (shots) await page.screenshot({ path: join(shots, `${engine}-${screen.name}-${lang}.png`) });
        assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
      } finally {
        await context.close();
      }
    }
  });
}

// Playwright drives service workers fully only in Chromium.
if (engine === 'chromium') {
  await check('installed app (PWA) works offline after the first visit', async () => {
    const { name, ...options } = desktop;
    const context = await browser.newContext({ ...options, serviceWorkers: 'allow' });
    context.setDefaultTimeout(15000);
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForSelector('#pattern .prow');
      const manifest = await page.evaluate(() => fetch(document.querySelector('link[rel=manifest]').href).then((r) => r.json()));
      assert(manifest.display === 'standalone', `${name}: the manifest is not a standalone app`);
      // The worker caches the whole build on install, then takes over the page.
      await page.evaluate(async () => {
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller)
          await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve));
      });
      const toast = await page.locator('#toast').textContent();
      assert(/offline/i.test(toast ?? ''), `${name}: no toast that the app works offline (${toast})`);
      await context.setOffline(true);
      for (const [path, ready] of [
        ['', '#pattern .prow'],
        ['?from=home-screen', '#pattern .prow'],
        ['manual.html', '.m-doc h2'],
      ]) {
        await page.goto(base + path, { waitUntil: 'load' });
        await page.waitForSelector(ready);
      }
      const loaded = await page.evaluate(() =>
        Promise.all([...document.querySelectorAll('.m-doc img')].map((img) => fetch(img.src).then((r) => r.ok, () => false))),
      );
      assert(loaded.length > 0 && loaded.every(Boolean), `${name}: manual images are not available offline`);
      assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
    } finally {
      await context.close();
    }
  });
}

await check('manual loads with its contents and images', async () => {
  for (const screen of [desktop, phone]) {
    const { context, page, errors } = await open(screen, { path: 'manual.html', ready: '.m-doc h2' });
    try {
      const { headings, links, images } = await page.evaluate(() => ({
        headings: document.querySelectorAll('.m-doc h2').length,
        links: document.querySelectorAll('#m-nav a').length,
        // The images load lazily, so fetch them instead of waiting for them to scroll into view.
        images: [...document.querySelectorAll('.m-doc img')].map((img) => img.src),
      }));
      const broken = [];
      for (const src of images) {
        const res = await page.request.get(src);
        if (!res.ok() || !/^image\//.test(res.headers()['content-type'] ?? '')) broken.push(src);
      }
      assert(headings >= 3, `${screen.name}: the manual has only ${headings} sections`);
      assert(links >= 3, `${screen.name}: the contents list has only ${links} links`);
      assert(broken.length === 0, `${screen.name}: images do not load: ${broken.join(', ')}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert(overflow <= 1, `${screen.name}: the manual scrolls sideways by ${overflow}px`);
      if (shots) await page.screenshot({ path: join(shots, `${engine}-${screen.name}-manual.png`) });
      assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
    } finally {
      await context.close();
    }
  }
});

await browser.close();
server.close();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed in ${engine}`);
  process.exit(1);
}
console.log(`\nall checks passed in ${engine}`);
