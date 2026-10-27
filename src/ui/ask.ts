import { t } from '../i18n';

/**
 * In-page replacements for `confirm()` and `prompt()`: a modal console panel in the style of the
 * About dialog, with blocky keys like the transport. Enter confirms, Escape or a click on the
 * backdrop cancels, and the focus returns to where it was when the dialog closes.
 */

export interface ConfirmOptions {
  /** Label of the confirm key, e.g. "Delete"; defaults to "OK". */
  ok?: string;
  /** Paints the confirm key in the red of the A button, for steps that throw something away. */
  danger?: boolean;
}

/** Asks a yes/no question; resolves to true when the user confirms. */
export async function askConfirm(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  return (await ask(message, options)) !== null;
}

/** Asks for a line of text; resolves to the text, or null when the user cancels. */
export function askText(message: string, value = '', options: ConfirmOptions = {}): Promise<string | null> {
  return ask(message, options, value);
}

let count = 0;

function ask(message: string, { ok, danger }: ConfirmOptions, value?: string): Promise<string | null> {
  const id = `ask-${++count}`;
  const el = document.createElement('dialog');
  el.className = 'about ask';
  el.setAttribute('aria-labelledby', `${id}-msg`);
  el.innerHTML = `
    <form method="dialog">
      <label class="ask-msg" id="${id}-msg"${value === undefined ? '' : ` for="${id}-input"`}></label>
      ${value === undefined ? '' : `<input class="ask-input" id="${id}-input" type="text" autocomplete="off" spellcheck="false">`}
      <div class="ask-keys">
        <button type="button" class="key-btn cancel" value="cancel">${t('ask.cancel')}</button>
        <button type="submit" class="key-btn ok${danger ? ' danger' : ''}" value="ok"></button>
      </div>
    </form>`;
  el.querySelector('.ask-msg')!.textContent = message;
  el.querySelector('.key-btn.ok')!.textContent = ok ?? t('ask.ok');
  const input = el.querySelector<HTMLInputElement>('.ask-input');
  if (input) input.value = value!;

  const opener = document.activeElement as HTMLElement | null;
  return new Promise((resolve) => {
    el.querySelector('.key-btn.cancel')!.addEventListener('click', () => el.close('cancel'));
    // A click on the backdrop cancels, as in the About dialog.
    el.addEventListener('click', (e) => {
      if (e.target === el) el.close('cancel');
    });
    el.addEventListener('close', () => {
      const confirmed = el.returnValue === 'ok';
      el.remove();
      opener?.focus?.({ preventScroll: true });
      resolve(confirmed ? (input?.value ?? '') : null);
    });
    document.body.append(el);
    // Escape fires `cancel` and closes with the previous returnValue, so start from "cancel".
    el.returnValue = 'cancel';
    el.showModal();
    if (input) {
      input.focus();
      input.select();
    } else el.querySelector<HTMLButtonElement>('.key-btn.ok')!.focus();
  });
}
