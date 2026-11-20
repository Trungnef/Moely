/**
 * DeepgramStreamingSTT - SDK-based streaming Speech-to-Text using Deepgram Nova-3
 *
 * Uses @deepgram/sdk v3 (listen.live) instead of raw WebSocket.
 * Implements the same EventEmitter interface as GoogleSTT:
 *   Events: 'transcript' ({ text, isFinal, confidence, speechFinal }), 'utterance_end', 'error' (Error)
 *   Methods: start(), stop(), write(chunk), setSampleRate(), setAudioChannelCount()
 */

import { EventEmitter } from 'events';
import { RECOGNITION_LANGUAGES } from '../config/languages';

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const RECONNECT_MAX_ATTEMPTS = 10;
const KEEPALIVE_INTERVAL_MS = 8000;

// Languages verified to stream on nova-3 (handshake accepted, 2026-11). Anything
// else starts on nova-2, which has the broadest language coverage. 'multi' is
// nova-3 code-switching (en/es/fr/de/hi/ru/pt/ja/it/nl — NOT Vietnamese).
const NOVA3_LANGUAGES = new Set([
    'multi', 'en', 'id', 'ru', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'tr', 'uk', 'vi', 'nl', 'hi',
]);

export class DeepgramStreamingSTT extends EventEmitter {
    private apiKey: string;
    private live: any = null;
    private isActive = false;
    private shouldReconnect = false;
    private isOpen = false; // tracks whether SDK connection is in OPEN state

    private sampleRate = 16000;
    private numChannels = 1;
    private languageCode = 'en';
    // Set when nova-3 refuses a non-English language at handshake — retry on nova-2.
    private forceNova2 = false;
    // nova-3 keyterm prompting: boosts recognition of names/jargon (e.g. "JAIST", "ContractNLI").
    private keyterms: string[] = [];

    private reconnectAttempts = 0;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private keepAliveInterval: NodeJS.Timeout | null = null;
    private buffer: Buffer[] = [];
    private isConnecting = false;

    constructor(apiKey: string) {
        super();
        this.apiKey = apiKey;
    }

    public setSampleRate(rate: number): void {
        if (this.sampleRate === rate) return;
        this.sampleRate = rate;
        console.log(`[DeepgramStreaming] Sample rate set to ${rate}`);
        if (this.isActive) this.restartStream();
    }

    public setAudioChannelCount(count: number): void {
        if (this.numChannels === count) return;
        this.numChannels = count;
        console.log(`[DeepgramStreaming] Channel count set to ${count}`);
        if (this.isActive) this.restartStream();
    }

    public setRecognitionLanguage(key: string): void {
        const next = key === 'auto' ? 'multi' : RECOGNITION_LANGUAGES[key]?.iso639;
        if (!next || next === this.languageCode) return;
        this.languageCode = next;
        this.forceNova2 = false;
        console.log(`[DeepgramStreaming] Language set to ${this.languageCode} (model=${this.getModel()})`);
        if (this.isActive) this.restartStream();
    }

    public setCredentials(_path: string): void { }

    /** Terms to boost (nova-3 only). Applied on the next connection; restarts an active stream. */
    public setKeyterms(terms: string[]): void {
        const next = Array.from(new Set((terms || []).map(t => String(t).trim()).filter(Boolean))).slice(0, 100);
        if (next.join('\u0000') === this.keyterms.join('\u0000')) return;
        this.keyterms = next;
        console.log(`[DeepgramStreaming] ${next.length} keyterm(s) configured`);
        if (this.isActive) this.restartStream();
    }

    private getModel(): string {
        if (this.forceNova2) return 'nova-2';
        return NOVA3_LANGUAGES.has(this.languageCode) ? 'nova-3' : 'nova-2';
    }

    private restartStream(): void {
        console.log('[DeepgramStreaming] Restarting due to config change...');
        this.stop();
        this.start();
    }

    public start(): void {
        // Active-but-not-reconnecting means we gave up after max attempts — allow a re-arm.
        if (this.isActive && this.shouldReconnect) return;
        this.isActive = true;
        this.shouldReconnect = true;
        this.reconnectAttempts = 0;
        this.connect();
    }

    public stop(): void {
        this.shouldReconnect = false;
        this.clearTimers();

        if (this.live) {
            const live = this.live;
            // Detach first so late events from the old socket can't touch the next one.
            this.live = null;
            try {
                live.requestClose();
            } catch {
                // ignore errors during shutdown
            }
        }

        this.isActive = false;
        this.isConnecting = false;
        this.isOpen = false;
        this.buffer = [];
        console.log('[DeepgramStreaming] Stopped');
    }

    public finalize(): void {
        if (!this.isActive || !this.isOpen || !this.live) return;
        try {
            this.live.finalize();
            console.log('[DeepgramStreaming] Sent Finalize to flush server buffer');
        } catch (err: any) {
            console.error('[DeepgramStreaming] Finalize failed:', err?.message);
        }
    }

    public write(chunk: Buffer): void {
        if (!this.isActive) return;

        if (!this.isOpen) {
            this.buffer.push(chunk);
            if (this.buffer.length > 500) this.buffer.shift();

            if (!this.isConnecting && this.shouldReconnect && !this.reconnectTimer) {
                this.connect();
            }
            return;
        }

        try {
            this.live.send(chunk);
        } catch (err: any) {
            console.error('[DeepgramStreaming] Send error:', err?.message);
        }
    }

    private connect(): void {
        if (this.isConnecting) return;
        this.isConnecting = true;

        const model = this.getModel();
        console.log(`[DeepgramStreaming] Connecting (model=${model}, rate=${this.sampleRate}, ch=${this.numChannels}, lang=${this.languageCode})...`);

        try {
            const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

            const deepgram = createClient(this.apiKey);

            const options: Record<string, unknown> = {
                model,
                language: this.languageCode,
                smart_format: true,
                interim_results: true,
                encoding: 'linear16',
                sample_rate: this.sampleRate,
                channels: this.numChannels,
                endpointing: 300,
                utterance_end_ms: 1000,
                vad_events: true,
            };
            // The SDK serializes arrays as repeated ?keyterm= params (verified accepted by nova-3).
            if (model === 'nova-3' && this.keyterms.length > 0) options.keyterm = this.keyterms;
            const live = deepgram.listen.live(options);
            this.live = live;
            let opened = false;
            // Every handler is bound to THIS connection. A restart (e.g. the first
            // chunk switching 16k→48k) replaces this.live while the old socket is
            // still opening/closing; without this guard the old socket's Open
            // handler would register a second Transcript listener on the new one
            // and its Close would clear the new connection's timers.
            const isCurrent = () => this.live === live;

            live.on(LiveTranscriptionEvents.Open, () => {
                if (!isCurrent()) {
                    try { live.requestClose(); } catch { }
                    return;
                }
                opened = true;
                this.isConnecting = false;
                this.isOpen = true;
                console.log(`[DeepgramStreaming] Connected (model=${model}, lang=${this.languageCode})`);

                live.on(LiveTranscriptionEvents.Transcript, (data: any) => {
                    if (!isCurrent()) return;
                    try {
                        const alt = data.channel?.alternatives?.[0];
                        const transcript = alt?.transcript;
                        const isFinal = data.is_final ?? false;
                        if (!transcript) {
                            // An empty speech_final still marks the end of the speaker's turn.
                            if (data.speech_final) this.emit('utterance_end');
                            return;
                        }
                        this.emit('transcript', {
                            text: transcript,
                            isFinal,
                            confidence: alt?.confidence ?? 1.0,
                            // speech_final = Deepgram endpointing saw trailing silence after this final.
                            speechFinal: data.speech_final === true,
                        });
                    } catch (err) {
                        console.error('[DeepgramStreaming] Parse error:', err);
                    }
                });

                // Fired after utterance_end_ms (1s) without new words — a reliable end-of-turn signal.
                live.on(LiveTranscriptionEvents.UtteranceEnd, () => {
                    if (isCurrent()) this.emit('utterance_end');
                });

                // Flush buffered audio
                const buffered = this.buffer.splice(0);
                for (const chunk of buffered) {
                    try { live.send(chunk); } catch { }
                }
                if (buffered.length > 0) {
                    console.log(`[DeepgramStreaming] Flushed ${buffered.length} buffered chunks`);
                }

                // SDK keepAlive() every 8s prevents idle timeout (per Deepgram docs)
                if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
                this.keepAliveInterval = setInterval(() => {
                    if (isCurrent() && this.isOpen) {
                        try { live.keepAlive(); } catch { }
                    }
                }, KEEPALIVE_INTERVAL_MS);

                // Reset backoff only after 5s of stable connection
                setTimeout(() => {
                    if (isCurrent() && this.isOpen) this.reconnectAttempts = 0;
                }, 5000);
            });

            live.on(LiveTranscriptionEvents.Error, (err: any) => {
                if (!isCurrent()) return;
                console.error('[DeepgramStreaming] Error:', err);
                this.emit('error', err instanceof Error ? err : new Error(String(err?.message ?? err)));
            });

            live.on(LiveTranscriptionEvents.Close, (event: any) => {
                if (!isCurrent()) return;
                const code = event?.code ?? 'unknown';
                const reason = event?.reason || '(empty)';
                console.log(`[DeepgramStreaming] Closed (code=${code}, reason=${reason})`);

                this.live = null;
                this.isOpen = false;
                this.isConnecting = false;
                this.clearTimers();

                // Never opened on nova-3 with a non-English language → most likely a
                // "No such model/language/tier combination" 400. Retry on nova-2.
                if (!opened && model === 'nova-3' && this.languageCode !== 'en' && !this.forceNova2) {
                    console.warn(`[DeepgramStreaming] nova-3 rejected lang=${this.languageCode}; falling back to nova-2`);
                    this.forceNova2 = true;
                }

                if (this.shouldReconnect && code !== 1000) {
                    this.scheduleReconnect();
                }
            });

        } catch (err: any) {
            console.error('[DeepgramStreaming] Initialization error:', err?.message);
            this.isConnecting = false;
            if (this.shouldReconnect) this.scheduleReconnect();
        }
    }

    private scheduleReconnect(): void {
        if (!this.shouldReconnect) return;

        // Discard stale buffered audio — replaying seconds-old audio on reconnect
        // overwhelms Deepgram's real-time endpoint and causes EPIPE storms.
        this.buffer = [];

        if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
            console.error(`[DeepgramStreaming] Max reconnect attempts reached — giving up`);
            // Stop write() from reconnecting on every chunk with no backoff.
            // A new start() (next meeting / config change) re-arms reconnects.
            this.shouldReconnect = false;
            this.emit('error', new Error('DeepgramStreamingSTT: max reconnect attempts exceeded'));
            return;
        }

        const delay = Math.min(
            RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts),
            RECONNECT_MAX_DELAY_MS
        );
        this.reconnectAttempts++;

        console.log(`[DeepgramStreaming] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS})...`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.shouldReconnect) this.connect();
        }, delay);
    }

    private clearTimers(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
    }
}
