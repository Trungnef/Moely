/**
 * InterviewPresetManager — one-click switching between interview setups
 * (e.g. "Company interview" vs "Scholarship interview").
 *
 * A preset bundles everything that decides how live answers are grounded and
 * how speech is recognised: the active Mode (custom instructions + reference
 * files), whether the stored resume/JD profile is used, the custom notes, the
 * STT languages for both channels, the answer language and STT keyterms.
 *
 * Presets are persisted as JSON in the app_state table. Applying a preset is
 * split in two: persistence here, plus optional live hooks supplied by the
 * main process so running STT / LLM instances pick the change up immediately.
 */

import crypto from 'crypto';
import { DatabaseManager } from '../db/DatabaseManager';
import { CredentialsManager } from './CredentialsManager';
import { SettingsManager } from './SettingsManager';
import { ModesManager } from './ModesManager';

export type InterviewPresetKind = 'company' | 'scholarship' | 'other';

export interface InterviewPreset {
    id: string;
    name: string;
    kind: InterviewPresetKind;
    modeId: string | null;
    useProfile: boolean;          // inject stored resume / JD / company research
    customNotes: string;
    sttLanguage: string;          // mic (user) channel
    sttLanguageInterviewer: string; // '' = same as sttLanguage
    aiResponseLanguage: string;   // 'auto' | 'English' | 'Vietnamese' | ...
    sttKeyterms: string[];
    createdAt: string;
    updatedAt: string;
}

export interface PresetLiveHooks {
    setRecognitionLanguage?: (key: string) => void;
    setInterviewerRecognitionLanguage?: (key: string) => void;
    setAiResponseLanguage?: (language: string) => void;
    setCustomNotes?: (notes: string) => void;
    setSttKeyterms?: (terms: string[]) => void;
    onModeChanged?: (id: string | null, name: string | null) => void;
    onApplied?: (preset: InterviewPreset) => void;
}

const STORE_KEY = 'interview_presets';
const ACTIVE_KEY = 'interview_presets:active';
const PERSONA_MODE_KEY = 'persona:mode';
const MAX_NOTES = 4000;
const MAX_KEYTERMS = 100;

export class InterviewPresetManager {
    private static instance: InterviewPresetManager;
    private hooks: PresetLiveHooks = {};

    public static getInstance(): InterviewPresetManager {
        if (!InterviewPresetManager.instance) {
            InterviewPresetManager.instance = new InterviewPresetManager();
        }
        return InterviewPresetManager.instance;
    }

    public setLiveHooks(hooks: PresetLiveHooks): void {
        this.hooks = hooks;
    }

    private db() {
        return DatabaseManager.getInstance();
    }

    public list(): InterviewPreset[] {
        const raw = this.db().getAppState(STORE_KEY);
        if (!raw) return [];
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.map(p => this.normalize(p)) : [];
        } catch {
            return [];
        }
    }

    public getActiveId(): string | null {
        return this.db().getAppState(ACTIVE_KEY) || null;
    }

    private persist(presets: InterviewPreset[]): void {
        this.db().setAppState(STORE_KEY, JSON.stringify(presets));
    }

    private normalize(p: Partial<InterviewPreset>): InterviewPreset {
        const now = new Date().toISOString();
        const kind: InterviewPresetKind = p.kind === 'company' || p.kind === 'scholarship' ? p.kind : 'other';
        return {
            id: p.id || `preset_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
            name: (p.name || 'Untitled preset').trim().slice(0, 80),
            kind,
            modeId: p.modeId ?? null,
            useProfile: p.useProfile !== false,
            customNotes: String(p.customNotes ?? '').slice(0, MAX_NOTES),
            sttLanguage: p.sttLanguage || 'english-us',
            sttLanguageInterviewer: p.sttLanguageInterviewer ?? '',
            aiResponseLanguage: p.aiResponseLanguage || 'auto',
            sttKeyterms: Array.from(new Set((p.sttKeyterms || []).map(t => String(t).trim()).filter(Boolean))).slice(0, MAX_KEYTERMS),
            createdAt: p.createdAt || now,
            updatedAt: p.updatedAt || now,
        };
    }

    /** Snapshot of the setup currently in effect — the "Save current setup" button. */
    public captureCurrent(): Omit<InterviewPreset, 'id' | 'name' | 'kind' | 'createdAt' | 'updatedAt'> {
        const creds = CredentialsManager.getInstance();
        const keyterms = SettingsManager.getInstance().get('sttKeyterms');
        return {
            modeId: ModesManager.getInstance().getActiveMode()?.id ?? null,
            useProfile: this.db().getAppState(PERSONA_MODE_KEY) === '1',
            customNotes: this.db().getCustomNotes(),
            sttLanguage: creds.getSttLanguage(),
            sttLanguageInterviewer: creds.getSttLanguageInterviewerOverride(),
            aiResponseLanguage: creds.getAiResponseLanguage(),
            sttKeyterms: Array.isArray(keyterms) ? keyterms : [],
        };
    }

    /** Create (no id / unknown id) or update a preset. Returns the stored preset. */
    public save(input: Partial<InterviewPreset>): InterviewPreset {
        const presets = this.list();
        const idx = input.id ? presets.findIndex(p => p.id === input.id) : -1;
        const merged = this.normalize({
            ...(idx >= 0 ? presets[idx] : {}),
            ...input,
            updatedAt: new Date().toISOString(),
        });
        if (idx >= 0) presets[idx] = merged; else presets.push(merged);
        this.persist(presets);
        return merged;
    }

    public delete(id: string): void {
        this.persist(this.list().filter(p => p.id !== id));
        if (this.getActiveId() === id) this.db().deleteAppState(ACTIVE_KEY);
    }

    /** Apply a preset: persist every setting, then push it into the running app. */
    public apply(id: string): InterviewPreset {
        const preset = this.list().find(p => p.id === id);
        if (!preset) throw new Error('Preset not found');

        const modes = ModesManager.getInstance();
        const modeExists = preset.modeId ? modes.getModes().some(m => m.id === preset.modeId) : false;
        modes.setActiveMode(modeExists ? preset.modeId : null);
        const active = modes.getActiveMode();
        this.hooks.onModeChanged?.(active?.id ?? null, active?.name ?? null);

        this.db().setAppState(PERSONA_MODE_KEY, preset.useProfile ? '1' : '0');
        SettingsManager.getInstance().set('knowledgeMode', preset.useProfile);

        this.db().saveCustomNotes(preset.customNotes);
        this.hooks.setCustomNotes?.(preset.customNotes);

        const creds = CredentialsManager.getInstance();
        if (this.hooks.setRecognitionLanguage) this.hooks.setRecognitionLanguage(preset.sttLanguage);
        else creds.setSttLanguage(preset.sttLanguage);
        if (this.hooks.setInterviewerRecognitionLanguage) this.hooks.setInterviewerRecognitionLanguage(preset.sttLanguageInterviewer);
        else creds.setSttLanguageInterviewer(preset.sttLanguageInterviewer);

        creds.setAiResponseLanguage(preset.aiResponseLanguage);
        this.hooks.setAiResponseLanguage?.(preset.aiResponseLanguage);

        SettingsManager.getInstance().set('sttKeyterms', preset.sttKeyterms);
        this.hooks.setSttKeyterms?.(preset.sttKeyterms);

        this.db().setAppState(ACTIVE_KEY, preset.id);
        this.hooks.onApplied?.(preset);
        console.log(`[InterviewPresets] Applied "${preset.name}" (mode=${active?.name ?? 'none'}, profile=${preset.useProfile ? 'on' : 'off'}, stt=${preset.sttLanguage}/${preset.sttLanguageInterviewer || 'same'}, answer=${preset.aiResponseLanguage})`);
        return preset;
    }
}
