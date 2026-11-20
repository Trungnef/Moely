/**
 * SonioxStreamingSTT - WebSocket-based streaming Speech-to-Text using Soniox
 *
 * Implements the same EventEmitter interface as GoogleSTT / DeepgramStreamingSTT:
 *   Events: 'transcript' ({ text, isFinal, confidence }), 'error' (Error)
 *   Methods: start(), stop(), write(chunk), setSampleRate(), setAudioChannelCount()
 *
 * Connects to wss://stt-rt.soniox.com/transcribe-websocket
 * Sends raw PCM (linear16, 16-bit LE) over WebSocket.
 * Receives token-based transcription results with is_final flags.
 *
 * Key features:
 *   - 60+ language auto-detection
 *   - Language hints for multilingual accuracy
 *   - Endpoint detection for auto-finalization on speech pauses
 *   - Up to 8000-token structured context for domain-specific terms
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { RECOGNITION_LANGUAGES } from '../config/languages';
import { streamingStttWsOptions } from './dnsHelpers';

const SONIOX_WEBSOCKET_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
// Cap reconnect attempts so a flapping network can't drive an indefinite WS
// open-loop against Soniox (storm risk + per-key rate-limit risk). After the
// cap, emit 'error' so the orchestrator can surface a UI prompt; a
// user-triggered restart via stop()/start() resets the counter to 0.
const RECONNECT_MAX_ATTEMPTS = 10;
const KEEPALIVE_INTERVAL_MS = 5000;

export class SonioxStreamingSTT extends EventEmitter {
    private apiKey: string;
    private ws: WebSocket | null = null;
    private isActive = false;
    private shouldReconnect = false;
    private configSent = false;

    private sampleRate = 16000;
    private numChannels = 1;

    private reconnectAttempts = 0;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private keepAliveTimer: NodeJS.Timeout | null = null;

    private buffer: Buffer[] = [];
    private isConnecting = false;

    constructor(apiKey: string) {
        super();
        this.apiKey = apiKey;
    }

    // =========================================================================
    // Configuration (match GoogleSTT / DeepgramStreamingSTT interface)
    // =========================================================================

    public setSampleRate(rate: number): void {
        if (this.sampleRate === rate) return;
        this.sampleRate = rate;
        console.log(`[SonioxStreaming] Sample rate set to ${rate}`);

        if (this.isActive) {
            console.log('[SonioxStreaming] Sample rate changed while active. Restarting...');
            // Save in-flight buffer so chunks captured between stop() and the new
            // WebSocket connect() are not silently discarded (matches Deepgram pattern)
            const savedBuffer = [...this.buffer];
            this.stop();
            this.start();
            if (savedBuffer.length > 0) {
                this.buffer = [...savedBuffer, ...this.buffer];
            }
        }
    }

    public setAudioChannelCount(count: number): void {
        this.numChannels = count;
        console.log(`[SonioxStreaming] Channel count set to ${count}`);
    }

    private languageCode?: string;

    /** Set recognition language hint using ISO-639-1 code */
    public setRecognitionLanguage(key: string): void {
        // 'auto' must be checked first: RECOGNITION_LANGUAGES has an 'auto' entry whose
        // iso639 is the literal "auto", which Soniox would receive as a bogus hint.
        const next = key === 'auto' ? undefined : RECOGNITION_LANGUAGES[key]?.iso639;
        if (key !== 'auto' && !next) return;
        if (next === this.languageCode) return;
        this.languageCode = next;
        console.log(`[SonioxStreaming] Language hint set to ${this.languageCode ?? 'auto'}`);

        if (this.isActive) {
            console.log('[SonioxStreaming] Language changed while active. Restarting...');
            this.stop();
            this.start();
        }
    }

    /** No-op — no Google credentials needed */
    public setCredentials(_path: string): void { }

    /**
     * No-op for keywords — Soniox uses structured context instead.
     * Context is set via the initial config message.
     */
    public setKeywords(_keywords: string[]): void { }

    // =========================================================================
    // Lifecycle
    // =========================================================================

    public start(): void {
        // Active-but-not-reconnecting means we gave up after max attempts — allow a re-arm.
        if (this.isActive && this.shouldReconnect) return;
        this.isActive = true;        // Set immediately so write() buffers audio during WS handshake
        this.shouldReconnect = true;
        this.reconnectAttempts = 0;
        this.connect();
    }

    public stop(): void {
        this.shouldReconnect = false;
        this.clearTimers();

        if (this.ws) {
            const ws = this.ws;
            // Detach first so the old socket's close/message handlers can't touch the next one.
            this.ws = null;
            try {
                // Send empty string to signal end-of-audio
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send('');
                }
            } catch {
                // Ignore send errors during shutdown
            }
            try { ws.close(1000); } catch { }
        }

        this.isActive = false;
        this.isConnecting = false;
        this.configSent = false;
        this.buffer = [];
        console.log('[SonioxStreaming] Stopped');
    }

    // =========================================================================
    // Audio Data
    // =========================================================================

    public write(chunk: Buffer): void {
        if (!this.isActive) return;

        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.configSent) {
            this.buffer.push(chunk);
            if (this.buffer.length > 500) this.buffer.shift(); // Cap buffer size

            if (!this.isConnecting && this.shouldReconnect && !this.reconnectTimer) {
                console.log('[SonioxStreaming] WS not ready. Lazy connecting on new audio...');
                this.connect();
            }
            return;
        }

        this.ws.send(chunk);
    }

    public finalize(): void {
        if (!this.isActive || !this.ws || !this.configSent) return;

        if (this.ws.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify({ type: 'finalize' }));
                console.log('[SonioxStreaming] Sent manual finalize message');
            } catch (err) {
                console.error('[SonioxStreaming] Failed to send finalize:', err);
            }
        }
    }

    // =========================================================================
    // WebSocket Connection
    // =========================================================================

    private connect(): void {
        if (this.isConnecting) return;
        this.isConnecting = true;

        console.log(`[SonioxStreaming] Connecting (rate=${this.sampleRate}, ch=${this.numChannels}, lang=${this.languageCode ?? 'auto'})...`);

        this.configSent = false;
        // streamingStttWsOptions: forces IPv4-only DNS lookup (sidesteps Node's
        // macOS dual-stack ENOTFOUND on IPv4-only CNAME chains) and caps the
        // TLS+upgrade handshake at 15s. See dnsHelpers.ts.
        const ws = new WebSocket(SONIOX_WEBSOCKET_URL, streamingStttWsOptions() as any);
        this.ws = ws;
        // All handlers are bound to THIS socket. A restart (sample-rate/language
        // change) replaces this.ws while the old socket is still closing; without
        // this guard the old close handler nulled the new socket and its 1005
        // close code scheduled a phantom reconnect.
        const isCurrent = () => this.ws === ws;

        ws.on('open', () => {
            // Guard: stop() may have been called while the WS handshake was in flight.
            if (!isCurrent() || !this.shouldReconnect || !this.isActive) {
                try { ws.close(1000); } catch { }
                if (isCurrent()) {
                    this.ws = null;
                    this.isConnecting = false;
                }
                return;
            }

            console.log('[SonioxStreaming] Connected, sending config...');

            // Send initial configuration as first message
            const config: any = {
                api_key: this.apiKey,
                model: 'stt-rt-v4',
                audio_format: 'pcm_s16le',
                sample_rate: this.sampleRate,
                num_channels: this.numChannels,
                enable_language_identification: true,
                enable_endpoint_detection: true,
            };

            if (this.languageCode) {
                config.language_hints = [this.languageCode];
            }

            try {
                ws.send(JSON.stringify(config));
                this.configSent = true;
                this.isConnecting = false;
                console.log('[SonioxStreaming] Config sent');

                // Flush buffer after config is sent
                while (this.buffer.length > 0) {
                    const chunk = this.buffer.shift();
                    if (chunk && ws.readyState === WebSocket.OPEN) {
                        ws.send(chunk);
                    }
                }
            } catch (err) {
                console.error('[SonioxStreaming] Failed to send config:', err);
                this.isConnecting = false;
            }

            // Start keep-alive pings
            this.startKeepAlive();
        });

        ws.on('message', (data: WebSocket.Data) => {
            if (!isCurrent()) return;
            try {
                const msg = JSON.parse(data.toString());

                // Error from server (bad key, bad config, quota...). Close the socket so
                // the bounded reconnect path counts it, instead of leaving a dead session.
                if (msg.error_code) {
                    console.error(`[SonioxStreaming] Server error: ${msg.error_code} - ${msg.error_message}`);
                    this.emit('error', new Error(`Soniox: ${msg.error_code} - ${msg.error_message}`));
                    try { ws.close(4000, 'server error'); } catch { }
                    return;
                }

                // The server accepted our config — only now is the connection healthy.
                // (Resetting on socket open let a server that keeps rejecting the config
                // retry forever.)
                this.reconnectAttempts = 0;

                // Parse tokens from response
                const tokens = msg.tokens;
                if (!tokens || !Array.isArray(tokens) || tokens.length === 0) return;

                let currentFinalText = '';
                let nonFinalText = '';
                let endpoint = false;

                for (const token of tokens) {
                    if (!token.text) continue;

                    if (token.text === '<fin>') {
                        console.log('[SonioxStreaming] Received <fin> manual finalization marker');
                        continue;
                    }

                    if (token.text === '<end>') {
                        // Endpoint detection: the speaker finished an utterance.
                        endpoint = true;
                        continue;
                    }

                    if (token.is_final) {
                        currentFinalText += token.text;
                    } else {
                        nonFinalText += token.text;
                    }
                }

                // 1. Emit final tokens immediately
                if (currentFinalText) {
                    this.emit('transcript', {
                        text: currentFinalText,
                        isFinal: true,
                        confidence: 1.0,
                        speechFinal: endpoint,
                    });
                }

                // 2. Emit non-final tokens as interim (live preview)
                if (nonFinalText) {
                    this.emit('transcript', {
                        text: nonFinalText,
                        isFinal: false,
                        confidence: 1.0,
                    });
                }

                if (endpoint) this.emit('utterance_end');

                // Session finished
                if (msg.finished) {
                    console.log('[SonioxStreaming] Session finished');
                    // We don't stop entirely, just clear WS so it can lazily reconnect on next audio
                    this.ws = null;
                    this.configSent = false;
                    this.clearKeepAlive();
                    try { ws.close(1000); } catch { }
                }
            } catch (err) {
                console.error('[SonioxStreaming] Parse error:', err);
            }
        });

        ws.on('error', (err: Error) => {
            if (!isCurrent()) return;
            console.error('[SonioxStreaming] WebSocket error:', err.message);
            this.emit('error', err);
        });

        ws.on('close', (code: number, reason: Buffer) => {
            console.log(`[SonioxStreaming] Closed (code=${code}, reason=${reason.toString()})`);
            if (!isCurrent()) return;
            this.ws = null;
            this.isConnecting = false;
            this.configSent = false;
            this.clearKeepAlive();

            // Auto-reconnect on unexpected close
            if (this.shouldReconnect && code !== 1000) {
                this.scheduleReconnect();
            }
        });
    }

    // =========================================================================
    // Reconnection
    // =========================================================================

    private scheduleReconnect(): void {
        if (!this.shouldReconnect) return;

        if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
            console.error(`[SonioxStreaming] Max reconnect attempts (${RECONNECT_MAX_ATTEMPTS}) reached — giving up`);
            // Latch off the reconnect path so write()'s lazy-connect (line 159)
            // cannot resurrect the storm on the next audio chunk. start() resets
            // shouldReconnect=true so a user-triggered restart still works.
            this.shouldReconnect = false;
            this.emit('error', new Error('SonioxStreamingSTT: max reconnect attempts exceeded'));
            return;
        }

        const delay = Math.min(
            RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts),
            RECONNECT_MAX_DELAY_MS
        );
        this.reconnectAttempts++;

        console.log(`[SonioxStreaming] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS})...`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.shouldReconnect) {
                this.connect();
            }
        }, delay);
    }

    // =========================================================================
    // Keep-alive
    // =========================================================================

    private startKeepAlive(): void {
        this.clearKeepAlive();
        this.keepAliveTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                try {
                    this.ws.ping();
                } catch {
                    // Ignore errors
                }
            }
        }, KEEPALIVE_INTERVAL_MS);
    }

    private clearKeepAlive(): void {
        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
    }

    private clearTimers(): void {
        this.clearKeepAlive();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
}
