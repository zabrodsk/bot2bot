// Small page behaviours: copy buttons, and the phone menu (Escape or a tap outside closes it).
import { onPage } from '../engine';

export function uiModule() {
  onPage(() => {
    const offs: (() => void)[] = [];

    // Arc copy button: the state swaps the icon and label, a polite status line says what happened.
    document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((btn) => {
      const label = btn.querySelector<HTMLElement>('[data-copy-label]');
      const status = btn.parentElement?.querySelector<HTMLElement>('[data-copy-status]');
      let t = 0;
      const copy = async () => {
        try {
          await navigator.clipboard.writeText(btn.dataset.copy || '');
          btn.dataset.state = 'copied';
          if (label) label.textContent = 'Copied';
          if (status) status.textContent = 'Copied';
        } catch {
          btn.dataset.state = 'error';
          if (status) status.textContent = 'Could not copy. Select the text and copy it.';
        }
        clearTimeout(t);
        t = window.setTimeout(() => {
          btn.dataset.state = 'idle';
          if (label) label.textContent = 'Copy';
          if (status) status.textContent = '';
        }, 1800);
      };
      btn.addEventListener('click', copy);
      offs.push(() => { btn.removeEventListener('click', copy); clearTimeout(t); });
    });

    const menu = document.querySelector<HTMLDetailsElement>('.menu');
    if (menu) {
      const close = (focus = false) => {
        if (!menu.open) return;
        menu.open = false;
        if (focus) menu.querySelector<HTMLElement>('summary')?.focus();
      };
      const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(true); };
      const onDown = (e: PointerEvent) => { if (!menu.contains(e.target as Node)) close(); };
      document.addEventListener('keydown', onKey);
      document.addEventListener('pointerdown', onDown);
      offs.push(() => {
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('pointerdown', onDown);
      });
    }

    return () => offs.forEach((f) => f());
  });
}
