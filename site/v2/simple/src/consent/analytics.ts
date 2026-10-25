// PostHog (EU cloud), only after the visitor allows analytics.
// Before consent nothing is imported, requested or stored. With an empty key it never loads.
// Page views are captured by hand on every astro:page-load, so view transitions count once each.
import type { PostHog } from 'posthog-js';
import { analytics } from '../data/site';
import { CONSENT_EVENT, readConsent, type ConsentValue } from './store';

const key: string = analytics.posthogKey || import.meta.env.PUBLIC_POSTHOG_KEY || '';
let ph: PostHog | null = null;
let loading: Promise<void> | null = null;
let allowed = false;

function load() {
  if (!key) return Promise.resolve();
  if (ph) {
    ph.opt_in_capturing({ captureEventName: false });
    ph.capture('$pageview');
    return Promise.resolve();
  }
  loading ??= import('posthog-js').then(({ default: posthog }) => {
    if (!allowed) return; // withdrawn while the script was on its way
    posthog.init(key, {
      api_host: analytics.posthogHost,
      person_profiles: 'identified_only',
      capture_pageview: false, // manual, below, once per astro:page-load
      capture_pageleave: true, // fires on tab close only, so it never doubles a page view
      disable_session_recording: true,
    });
    ph = posthog;
    ph.capture('$pageview');
  }).finally(() => { loading = null; });
  return loading;
}

// Deletes everything PostHog keeps in this browser: ph_<key>_posthog (cookie and localStorage),
// ph_<key>_window_id and friends (sessionStorage), and __ph_opt_in_out_<key>.
function clearStorage() {
  const isPh = (name: string) => name.startsWith('ph_') || name.startsWith('__ph_');
  for (const store of [localStorage, sessionStorage]) {
    try { Object.keys(store).filter(isPh).forEach((k) => store.removeItem(k)); } catch { /* blocked storage */ }
  }
  const host = location.hostname;
  const domains = ['', host, `.${host}`, `.${host.split('.').slice(-2).join('.')}`];
  document.cookie.split(';').map((c) => c.split('=')[0].trim()).filter(isPh).forEach((name) => {
    domains.forEach((d) => { document.cookie = `${name}=; Max-Age=0; Path=/${d ? `; Domain=${d}` : ''}`; });
  });
}

function stop() {
  ph?.opt_out_capturing();
  clearStorage();
}

function apply(value: ConsentValue | null) {
  const next = !!value?.analytics;
  if (next === allowed) return;
  allowed = next;
  if (allowed) void load();
  else stop();
}

export function startAnalytics() {
  allowed = false;
  const saved = readConsent();
  if (saved?.value.analytics) apply(saved.value);
  document.addEventListener(CONSENT_EVENT, (e) => apply((e as CustomEvent<{ value: ConsentValue | null }>).detail.value));
  // The first astro:page-load comes before PostHog is ready; load() captures that first view itself.
  document.addEventListener('astro:page-load', () => { if (ph && allowed) ph.capture('$pageview'); });
}
