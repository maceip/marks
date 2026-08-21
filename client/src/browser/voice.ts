import { speechRecognitionCtor, type SpeechRecognitionLike } from './platform.ts';

export type VoiceStatus = 'idle' | 'listening' | 'unsupported' | 'denied' | 'error';

export interface VoiceTranscript {
  /** Stable text already committed into the document. */
  finalText: string;
  /** Current hypothesis, not yet committed. */
  interimText: string;
}

export interface VoiceSessionOptions {
  lang?: string;
  onTranscript: (transcript: VoiceTranscript) => void;
  onStatus: (status: VoiceStatus) => void;
}

/**
 * Push-to-talk speech input.
 *
 * Interim results stay out of the CRDT — committing every hypothesis would
 * generate a storm of inserts and make undo unusable. Only `final` chunks
 * are reported for insertion at the cursor.
 */
export class VoiceSession {
  private recognition: SpeechRecognitionLike | null = null;
  private status: VoiceStatus;
  private wantRunning = false;

  constructor(private readonly options: VoiceSessionOptions) {
    this.status = speechRecognitionCtor() ? 'idle' : 'unsupported';
  }

  supported(): boolean {
    return this.status !== 'unsupported';
  }

  currentStatus(): VoiceStatus {
    return this.status;
  }

  start(): void {
    if (this.status === 'unsupported') {
      this.options.onStatus('unsupported');
      return;
    }
    const Ctor = speechRecognitionCtor();
    if (!Ctor) {
      this.setStatus('unsupported');
      return;
    }

    this.stopInternal();
    this.wantRunning = true;

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = this.options.lang ?? defaultLang();

    recognition.onresult = (event) => {
      let finalText = '';
      let interimText = '';
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index];
        const piece = result[0]?.transcript ?? '';
        if (result.isFinal) finalText += piece;
        else interimText += piece;
      }
      if (finalText || interimText) {
        this.options.onTranscript({ finalText, interimText });
      }
    };

    recognition.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        this.wantRunning = false;
        this.setStatus('denied');
        return;
      }
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      this.setStatus('error');
    };

    recognition.onend = () => {
      // Chrome ends a continuous session after a pause. Restart if the user
      // still wants it, unless we were denied.
      if (this.wantRunning && this.status !== 'denied') {
        try {
          recognition.start();
        } catch {
          this.setStatus('idle');
        }
      } else if (this.status === 'listening') {
        this.setStatus('idle');
      }
    };

    try {
      recognition.start();
      this.recognition = recognition;
      this.setStatus('listening');
    } catch {
      this.wantRunning = false;
      this.setStatus('error');
    }
  }

  stop(): void {
    this.wantRunning = false;
    this.stopInternal();
    if (this.status === 'listening') this.setStatus('idle');
  }

  toggle(): void {
    if (this.status === 'listening') this.stop();
    else this.start();
  }

  destroy(): void {
    this.wantRunning = false;
    this.stopInternal();
  }

  private stopInternal(): void {
    const recognition = this.recognition;
    this.recognition = null;
    if (!recognition) return;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    try {
      recognition.abort();
    } catch {
      // already stopped
    }
  }

  private setStatus(status: VoiceStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatus(status);
  }
}

function defaultLang(): string {
  if (typeof navigator === 'undefined') return 'en-US';
  return navigator.language || 'en-US';
}
