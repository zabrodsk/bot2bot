// Astro adapter (ClientRouter). Call start(setup) once from the layout's <script>.
// The leave animation runs IN PARALLEL with fetching the next page, so transitions add no latency.
import { boot, cleanup, enter, leave, syncFlags } from './index';

let navigating = false;
let popstate = false;

export function start(setup?: () => void) {
  addEventListener('popstate', () => { popstate = true; });
  document.addEventListener('astro:before-preparation', (e) => {
    navigating = true;
    const load = e.loader;
    e.loader = async () => { await Promise.all([leave(), load()]); };
  });
  document.addEventListener('astro:before-swap', () => cleanup());
  document.addEventListener('astro:after-swap', () => {
    syncFlags(); // Astro replaces <html> attributes; restore flags before paint
    document.getElementById('loader')?.remove(); // the loader is first-load only
  });
  document.addEventListener('astro:page-load', () => {
    if (!navigating) return void boot(setup);
    navigating = false;
    const back = popstate;
    popstate = false;
    enter({ scrollTop: !back });
  });
  boot(setup);
}
