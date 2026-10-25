// The visitor's cookie choice, shared by this site and the dashboard on the same domain.
//
// localStorage['b2b-consent'] holds JSON in the shape of Arc's readCookieConsent:
//   {
//     "value":     { "necessary": true, "analytics": false },  // category id → allowed
//     "version":   "1",                                         // bump in site.ts to ask everyone again
//     "updatedAt": "2026-10-24T09:30:00.000Z"                   // ISO time of the choice
//   }
// A missing key, broken JSON or another version all mean "not decided yet".
// Changes are announced on document as a 'b2b:consent' CustomEvent with detail { value, action }.
import { consent } from '../data/site';

export type ConsentValue = Record<string, boolean>;
export type ConsentAction = 'accept-all' | 'reject-all' | 'save' | 'reset';
export interface StoredConsent { value: ConsentValue; version: string; updatedAt: string }

export const CONSENT_EVENT = 'b2b:consent';

export function readConsent(key = consent.storageKey, version = consent.version): StoredConsent | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredConsent>;
    if (!parsed || typeof parsed.value !== 'object' || parsed.value === null || parsed.version !== version) return null;
    return { value: parsed.value, version: parsed.version, updatedAt: String(parsed.updatedAt ?? '') };
  } catch {
    return null;
  }
}

export function writeConsent(value: ConsentValue | null, action: ConsentAction) {
  const updatedAt = new Date();
  try {
    if (value) localStorage.setItem(consent.storageKey, JSON.stringify({ value, version: consent.version, updatedAt: updatedAt.toISOString() }));
    else localStorage.removeItem(consent.storageKey);
  } catch { /* Storage can be blocked; the event still reports the choice for this visit. */ }
  document.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: { value, action, updatedAt } }));
}
