/**
 * Feature detection for the browser surface.
 *
 * Every capability here is optional: the editor must keep working when a
 * browser withholds it (Firefox without SpeechRecognition, Safari without
 * `clipboard.read`, a locked-down iframe without Web Locks). Callers branch
 * on these, they never throw.
 */

export function isCoarsePointer(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

export function isApple(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform);
}

export function modifierLabel(): string {
  return isApple() ? '⌘' : 'Ctrl';
}

export function hasClipboardWrite(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.clipboard?.writeText);
}

export function hasClipboardRead(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.clipboard?.readText);
}

export function hasWebLocks(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.locks?.request);
}

export function hasBroadcastChannel(): boolean {
  return typeof BroadcastChannel !== 'undefined';
}

export function hasServiceWorker(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

export function isAutomatedBrowser(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.webdriver);
}

export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

export interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export interface SpeechRecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

export function speechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const candidate = (window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }).SpeechRecognition ??
    (window as Window & { webkitSpeechRecognition?: SpeechRecognitionCtor }).webkitSpeechRecognition;
  return candidate ?? null;
}

/** True when this page is a background tab. Frozen pages still report hidden. */
export function pageIsVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}
