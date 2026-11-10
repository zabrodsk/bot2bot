// Shared browser privacy controls. Keep this function self-contained for the relay's inline script.
export function privacyOptions(dashboard = false) {
  // Only campaign slugs, never free text, identifiers from ad platforms or first-touch profiles.
  const utms = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'];
  const validUtm = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,99}$/.test(value);
  const campaignNoise = /initial|search|campaign|utm_|(?:^\$?)(?:.*clid|gclsrc|gad_source|gbraid|wbraid|mc_cid|rdt_cid|li_fat_id|igshid|epik|sccid|oppref|bfcid|_kx)$/i;
  const safeUrl = (raw) => {
    try {
      const u = new URL(raw, location.origin);
      if (u.origin !== location.origin) return '[redacted]';
      // Keep public page names only. Dashboard IDs, all queries and fragments are unnecessary.
      if (!/^\/(?:_astro|fonts|images|art|stickers)\//.test(u.pathname)) u.pathname = u.pathname.split('/').map((s) => /^(app|account|activity|people|bots|inbox|billing|feedback|docs|pricing|privacy|cookies|security|start|agents|terms|legal|changelog|faq|agent-to-agent|compare|a2a|how-it-works|mcp|limits|troubleshooting|invites|quickstart|baskets|api|setup-bot|chatgpt|self-host|messages|openclaw|coding-agents|encryption|keys|doorbell|cli|connect|)$/.test(s) ? s : '[redacted]').join('/');
      u.search = ''; u.hash = ''; u.username = ''; u.password = '';
      return u.toString();
    } catch { return ''; }
  };
  return {
    person_profiles: /** @type {const} */ ('identified_only'), capture_pageview: false,
    autocapture: { dom_event_allowlist: /** @type {['click']} */ (['click']), element_allowlist: /** @type {['a', 'button']} */ (['a', 'button']), capture_copied_text: false },
    mask_all_text: dashboard, mask_all_element_attributes: true,
    capture_pageleave: false, capture_performance: { web_vitals: true, network_timing: false, web_vitals_attribution: false },
    capture_exceptions: true, capture_heatmaps: true, capture_dead_clicks: true,
    enable_recording_console_log: false, ip: false, persistence: /** @type {const} */ ('localStorage'),
    save_referrer: false, save_campaign_params: true, advanced_disable_surveys: true,
    session_recording: {
      // Keep snapshots readable by before_send. Requests still use gzip compression.
      compress_events: false,
      maskAllInputs: true, maskTextSelector: dashboard ? '*' : '.ph-mask',
      maskAllElementAttributes: dashboard,
      maskAttributeFn: dashboard ? undefined : (name, value) => /^(href|src|action)$/i.test(name) ? safeUrl(value) : /^(value|title|alt|data-)/i.test(name) ? '[redacted]' : value,
      blockSelector: 'input[type="hidden"], input[type="file"], video, audio, canvas, iframe, object, script, .ph-no-capture' + (dashboard ? ', img, svg' : ''),
      recordHeaders: false, recordBody: false, captureCanvas: { recordCanvas: false },
      // The SDK also calls this hook with only a name to sanitize replay page URLs.
      maskCapturedNetworkRequestFn: (data) => Object.keys(data).length === 1 && typeof data.name === 'string' ? { ...data, name: safeUrl(data.name) } : null,
    },
    before_send: (event) => {
      if (!event || !['$pageview', '$pageleave', '$autocapture', '$rageclick', '$dead_click', '$web_vitals', '$exception', '$$heatmap', '$snapshot', 'bot_connected'].includes(event.event)) return null;
      const p = event.properties || {};
      if (event.event === 'bot_connected') {
        if (!['grokbot', 'connector'].includes(p.vendor)) return null;
        for (const k of Object.keys(p)) if (!k.startsWith('$') && !utms.includes(k) && !['vendor', 'token', 'distinct_id'].includes(k)) delete p[k];
      }
      if (event.event === '$exception') {
        const redact = (text) => String(text || '').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]').replace(/https?:\/\/[^\s)]+/g, (url) => safeUrl(url)).replace(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g, '[code]').replace(/\b(?:ph[cx]_|sk_|s_|ac_|Bearer\s+)[A-Za-z0-9_./+-]+/gi, '[credential]').replace(/\b(?:token|password|secret|api[_-]?key|code)\s*[:=]\s*[^\s,;]+/gi, '[credential]').slice(0, 2000);
        p.$exception_list = (p.$exception_list || []).map((error) => ({
          type: redact(error.type), value: redact(error.value),
          mechanism: error.mechanism ? { type: redact(error.mechanism.type), handled: !!error.mechanism.handled } : undefined,
          stacktrace: { type: 'raw', frames: (error.stacktrace?.frames || []).map((frame) => ({
            filename: frame.filename ? safeUrl(frame.filename) : undefined,
            abs_path: frame.abs_path ? safeUrl(frame.abs_path) : undefined,
            function: redact(frame.function), lineno: frame.lineno, colno: frame.colno, in_app: frame.in_app,
          })) },
        }));
        for (const k of Object.keys(p)) if (/exception|error/i.test(k) && k !== '$exception_list' && !['$exception_level', '$exception_source'].includes(k)) delete p[k];
      }

      for (const k of Object.keys(p)) {
        if (utms.includes(k)) { if (!validUtm(p[k])) delete p[k]; continue; }
        if (/url|href|referrer|pathname/i.test(k)) p[k] = typeof p[k] === 'string' ? safeUrl(p[k]) : '';
        if (/pathname/i.test(k) && p[k]) p[k] = new URL(p[k], location.origin).pathname;
        if (k !== 'token' && (/email|token|secret|password|key/i.test(k) || campaignNoise.test(k))) delete p[k];
        if (dashboard && /title|text|elements_chain/i.test(k)) delete p[k];
      }
      // rrweb's meta event carries the current URL separately from event properties.
      const scrub = (v) => {
        if (!v || typeof v !== 'object') return;
        for (const k of Object.keys(v)) {
          if (utms.includes(k)) { if (!validUtm(v[k])) delete v[k]; }
          else if (campaignNoise.test(k)) delete v[k];
          else if (/^https?:\/\//i.test(k)) { const clean = safeUrl(k); if (clean !== k) { v[clean] = v[k]; delete v[k]; } scrub(v[clean]); }
          else if (typeof v[k] === 'string' && (/^(href|url)$/i.test(k) || /^https?:\/\//i.test(v[k]))) v[k] = safeUrl(v[k]);
          else scrub(v[k]);
        }
      };
      scrub(p);
      if (Array.isArray(p.$elements)) p.$elements = p.$elements.map((el) => Object.fromEntries(Object.entries(el).filter(([k]) => ['tag_name', 'nth_child', 'nth_of_type', ...(dashboard ? [] : ['$el_text'])].includes(k))));
      event.properties = p;
      return event;
    },
  };
}

// IDs stay in this browser for deduplication; only vendor is sent to PostHog.
// The first consented observation counts, including bots connected before this release.
export function captureConnectedBots(sdk) {
  document.querySelectorAll('[data-analytics-connected]').forEach((el) => {
    const id = el.getAttribute('data-analytics-connected'), vendor = el.getAttribute('data-vendor');
    if (!/^\d+$/.test(id) || !['grokbot', 'connector'].includes(vendor)) return;
    const key = `ph_b2b_connected_${id}`;
    try {
      if (localStorage.getItem(key)) return;
      // Mark before capture so a dashboard refresh or repeated consent callback cannot double count.
      localStorage.setItem(key, '1');
      sdk.capture('bot_connected', { vendor });
    } catch { /* No persistent deduplication available: skip rather than count every refresh. */ }
  });
}

export function clearPostHogStorage() {
  const isPh = (k) => k.startsWith('ph_') || k.startsWith('__ph_');
  for (const getStore of [() => localStorage, () => sessionStorage]) {
    try { const store = getStore(); Object.keys(store).filter(isPh).forEach((k) => store.removeItem(k)); } catch { /* blocked storage */ }
  }
  const host = location.hostname;
  const domains = ['', host, `.${host}`, `.${host.split('.').slice(-2).join('.')}`];
  document.cookie.split(';').map((c) => c.split('=')[0].trim()).filter(isPh).forEach((name) => {
    domains.forEach((d) => { document.cookie = `${name}=; Max-Age=0; Path=/${d ? `; Domain=${d}` : ''}`; });
  });
}

// Allow only ordinary signed-in pages. Approvals, setup, invitations and admin stay outside.
export function replayPage(path) {
  return /^\/app(?:\/(?:account|activity|people|bots|inbox|billing|feedback)(?:\/\d+)*)?\/?$/.test(path);
}

function dashboardConsent(config, privacyOptions, clearPostHogStorage, captureConnectedBots) {
  const root = document.getElementById('b2b-cookie');
  const form = root.querySelector('form');
  let choice = {}, ph = null, pending = false;
  const read = () => {
    try { const c = JSON.parse(localStorage.getItem('b2b-consent')); return c?.version === '3' ? c.value : null; } catch { return null; }
  };
  const apply = (next) => {
    const old = choice;
    choice = next || {};
    if ((old.analytics && !choice.analytics) || (old.replay && !choice.replay)) {
      ph?.stopSessionRecording(); ph?.opt_out_capturing(); clearPostHogStorage();
      if (ph && (choice.analytics || choice.replay)) { location.reload(); return; }
    }
    if (choice.analytics !== true && choice.replay !== true) { clearPostHogStorage(); return; }
    if (ph) {
      ph.opt_in_capturing({ captureEventName: false });
      ph.set_config({ save_campaign_params: !!choice.analytics, disable_session_recording: !choice.replay, autocapture: choice.analytics ? privacyOptions(true).autocapture : false, capture_pageleave: !!choice.analytics, capture_exceptions: !!choice.analytics, capture_heatmaps: !!choice.analytics, capture_dead_clicks: !!choice.analytics, capture_performance: choice.analytics ? privacyOptions(true).capture_performance : false });
      if (choice.analytics) captureConnectedBots(ph);
      if (choice.replay) ph.startSessionRecording();
      return;
    }
    if (pending) return;
    pending = true;
    const script = document.createElement('script');
    script.src = 'https://eu-assets.i.posthog.com/static/array.js';
    script.async = true;
    script.onerror = () => { pending = false; };
    script.onload = () => {
      pending = false;
      if (choice.analytics !== true && choice.replay !== true) return;
      ph = window.posthog;
      const options = privacyOptions(true);
      ph.init(config.key, { ...options, api_host: 'https://eu.i.posthog.com',
        save_campaign_params: !!choice.analytics,
        disable_session_recording: !choice.replay,
        autocapture: choice.analytics ? options.autocapture : false, capture_pageleave: !!choice.analytics, capture_exceptions: !!choice.analytics, capture_heatmaps: !!choice.analytics, capture_dead_clicks: !!choice.analytics, capture_performance: choice.analytics ? privacyOptions(true).capture_performance : false,
        before_send: (event) => {
          if (event?.event !== '$snapshot' && !choice.analytics) return null;
          if (event?.event === '$snapshot' && !choice.replay) return null;
          return options.before_send(event);
        },
        loaded: (sdk) => { if (choice.analytics) { sdk.capture('$pageview'); captureConnectedBots(sdk); } },
      });
    };
    document.head.append(script);
  };
  const open = () => {
    const c = read() || {};
    form.elements.analytics.checked = c.analytics === true;
    form.elements.replay.checked = c.replay === true;
    root.hidden = false;
  };
  document.addEventListener('click', (e) => { if (e.target.closest('[data-cookie-settings]')) { e.preventDefault(); open(); form.elements.analytics.focus(); } });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const action = e.submitter?.value;
    const value = { necessary: true, analytics: action === 'accept' || (action === 'save' && form.elements.analytics.checked), replay: action === 'accept' || (action === 'save' && form.elements.replay.checked) };
    try { localStorage.setItem('b2b-consent', JSON.stringify({ value, version: '3', updatedAt: new Date().toISOString() })); } catch { /* this visit only */ }
    root.hidden = true; apply(value);
  });
  window.addEventListener('storage', (e) => {
    if (e.key !== 'b2b-consent' && e.key !== null) return;
    const c = read(); apply(c); if (!c) open(); else root.hidden = true;
  });
  const saved = read(); apply(saved); if (!saved) open();
}

export function consentMarkup(tr, key) {
  return `<style>
#b2b-cookie{position:fixed;z-index:100;bottom:20px;left:20px;width:min(420px,calc(100vw - 40px));border:1px solid var(--border);border-radius:20px;background:var(--surface,Canvas);color:var(--foreground,CanvasText);padding:20px;box-shadow:0 8px 32px #0002;font-size:14px;max-height:80vh;overflow:auto}
#b2b-cookie[hidden]{display:none}#b2b-cookie h2{font-size:18px;margin:0 0 10px}#b2b-cookie label{display:block;margin:12px 0}#b2b-cookie p{margin:8px 0}#b2b-cookie .cc-actions{display:flex;gap:8px;flex-wrap:wrap}.cookie-settings{font:inherit;color:inherit;background:none;border:0;text-decoration:underline;cursor:pointer}
</style><section id="b2b-cookie" role="dialog" aria-modal="false" aria-labelledby="b2b-cookie-title" hidden><form>
<h2 id="b2b-cookie-title">${tr('Cookie settings')}</h2>
<p>${tr('Choose either, both or neither. The service works without them. PostHog is hosted in the EU.')}</p>
<label><input type="checkbox" name="analytics"> ${tr('Analytics: visits, clicks, heatmaps, errors and page speed.')}</label>
<label><input type="checkbox" name="replay"> ${tr('Session recordings: find usability problems. Typed text and dashboard content are masked. Kept for 30 days.')}</label>
<p><a href="/cookies/">${tr('Cookie policy')}</a></p>
<div class="cc-actions"><button class="btn secondary small" value="reject">${tr('Reject all')}</button><button class="btn secondary small" value="accept">${tr('Accept all')}</button><button class="btn small" value="save">${tr('Save choices')}</button></div>
</form></section><script>(${dashboardConsent.toString()})(${JSON.stringify({ key })}, ${privacyOptions.toString()}, ${clearPostHogStorage.toString()}, ${captureConnectedBots.toString()});</script>`;
}

export const ANALYTICS_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://eu-assets.i.posthog.com; connect-src 'self' https://eu.i.posthog.com https://eu-assets.i.posthog.com; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
