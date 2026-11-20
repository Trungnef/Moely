import { useCallback, useEffect, useMemo, useState } from 'react';
import { Building2, GraduationCap, Layers, Plus, Check, Pencil, Trash2, Loader2, X } from 'lucide-react';

type PresetKind = 'company' | 'scholarship' | 'other';

interface Preset {
    id: string;
    name: string;
    kind: PresetKind;
    modeId: string | null;
    useProfile: boolean;
    customNotes: string;
    sttLanguage: string;
    sttLanguageInterviewer: string;
    aiResponseLanguage: string;
    sttKeyterms: string[];
    createdAt: string;
    updatedAt: string;
}

type Draft = Omit<Preset, 'createdAt' | 'updatedAt' | 'id'> & { id?: string };

const KIND_META: Record<PresetKind, { label: string; icon: any }> = {
    company: { label: 'Company', icon: Building2 },
    scholarship: { label: 'Scholarship', icon: GraduationCap },
    other: { label: 'Other', icon: Layers },
};

const fieldCls = 'w-full bg-bg-input border border-border-subtle rounded-xl px-3 py-2 text-[13px] text-text-primary focus:outline-none focus:border-border-muted';
const labelCls = 'block text-[11px] font-semibold uppercase tracking-wider text-text-tertiary mb-1.5';

/**
 * One-click switching between interview setups (company vs scholarship ...).
 * Each preset bundles the Mode, resume/JD usage, notes, STT languages,
 * answer language and STT keyterms; applying it takes effect immediately.
 */
export function InterviewPresetsCard({ onApplied }: { onApplied?: () => void }) {
    const api = window.electronAPI;
    const [presets, setPresets] = useState<Preset[]>([]);
    const [activeId, setActiveId] = useState<string | null>(null);
    const [modes, setModes] = useState<Array<{ id: string; name: string }>>([]);
    const [sttLanguages, setSttLanguages] = useState<Record<string, any>>({});
    const [aiLanguages, setAiLanguages] = useState<Array<{ label: string; code: string }>>([]);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [keytermText, setKeytermText] = useState('');
    const [busyId, setBusyId] = useState<string | null>(null);
    const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

    const reload = useCallback(async () => {
        const res = await api?.interviewPresetsList?.();
        if (res) { setPresets(res.presets); setActiveId(res.activeId); }
    }, [api]);

    useEffect(() => {
        reload().catch(() => { });
        api?.modesGetAll?.().then(m => setModes((m || []).map(x => ({ id: x.id, name: x.name })))).catch(() => { });
        api?.getRecognitionLanguages?.().then(l => setSttLanguages(l || {})).catch(() => { });
        api?.getAiResponseLanguages?.().then(l => setAiLanguages(l || [])).catch(() => { });
        const off = api?.onInterviewPresetApplied?.(() => { reload().catch(() => { }); });
        return () => { off?.(); };
    }, [api, reload]);

    const flash = (kind: 'ok' | 'error', text: string) => {
        setMessage({ kind, text });
        setTimeout(() => setMessage(null), 3500);
    };

    const sttOptions = useMemo(() => Object.entries(sttLanguages)
        .map(([key, l]: [string, any]) => ({ key, label: l.group === 'English' ? `English (${l.label})` : l.label })),
        [sttLanguages]);
    const sttLabel = (key: string) => sttOptions.find(o => o.key === key)?.label ?? key;
    const modeName = (id: string | null) => (id ? modes.find(m => m.id === id)?.name : null) ?? 'No mode';

    const startNew = async () => {
        const current = await api?.interviewPresetsCapture?.();
        if (!current) return;
        setDraft({ ...current, name: '', kind: 'company' });
        setKeytermText((current.sttKeyterms || []).join(', '));
    };

    const startEdit = (p: Preset) => {
        setDraft({ ...p });
        setKeytermText(p.sttKeyterms.join(', '));
    };

    const saveDraft = async () => {
        if (!draft) return;
        if (!draft.name.trim()) { flash('error', 'Give the preset a name.'); return; }
        const sttKeyterms = keytermText.split(/[,\n]/).map(t => t.trim()).filter(Boolean);
        const res = await api?.interviewPresetsSave?.({ ...draft, sttKeyterms });
        if (res?.success) {
            setDraft(null);
            await reload();
            flash('ok', `Saved "${res.preset?.name}".`);
        } else {
            flash('error', res?.error || 'Could not save the preset.');
        }
    };

    const apply = async (p: Preset) => {
        setBusyId(p.id);
        try {
            const res = await api?.interviewPresetsApply?.(p.id);
            if (res?.success) {
                setActiveId(p.id);
                flash('ok', `"${p.name}" is now active.`);
                onApplied?.();
            } else {
                flash('error', res?.error || 'Could not apply the preset.');
            }
        } finally {
            setBusyId(null);
        }
    };

    const remove = async (p: Preset) => {
        if (!confirm(`Delete preset "${p.name}"? Your modes, resume and notes are not deleted.`)) return;
        await api?.interviewPresetsDelete?.(p.id);
        await reload();
    };

    return (
        <div className="p-5">
            <div className="flex items-start justify-between gap-4 mb-4">
                <div>
                    <h4 className="text-sm font-bold text-text-primary tracking-tight">Interview presets</h4>
                    <p className="text-xs text-text-secondary mt-0.5">
                        Switch the whole setup in one click: mode, resume & JD, notes, languages and key terms.
                    </p>
                </div>
                {!draft && (
                    <button
                        onClick={startNew}
                        className="shrink-0 flex items-center gap-1.5 text-[12px] font-semibold text-text-primary bg-bg-input border border-border-subtle rounded-full px-3 py-1.5 hover:bg-bg-surface transition-colors"
                    >
                        <Plus size={13} /> Save current setup
                    </button>
                )}
            </div>

            {message && (
                <div className={`mb-3 text-[12px] px-3 py-2 rounded-xl border ${message.kind === 'ok' ? 'text-emerald-400 border-emerald-500/20 bg-emerald-500/10' : 'text-red-400 border-red-500/20 bg-red-500/10'}`}>
                    {message.text}
                </div>
            )}

            {!draft && presets.length === 0 && (
                <p className="text-[12px] text-text-tertiary px-1 py-3">
                    No presets yet. Set up the app for one kind of interview, then click "Save current setup".
                </p>
            )}

            {!draft && presets.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {presets.map(p => {
                        const Icon = KIND_META[p.kind].icon;
                        const isActive = p.id === activeId;
                        return (
                            <div
                                key={p.id}
                                className={`rounded-2xl border p-4 flex flex-col gap-3 transition-colors ${isActive ? 'border-accent-primary/60 bg-accent-primary/5' : 'border-border-subtle bg-bg-input/40'}`}
                            >
                                <div className="flex items-start justify-between gap-2">
                                    <div className="flex items-center gap-2.5 min-w-0">
                                        <div className="w-8 h-8 rounded-full bg-bg-input border border-border-subtle flex items-center justify-center text-text-primary shrink-0">
                                            <Icon size={15} />
                                        </div>
                                        <div className="min-w-0">
                                            <div className="text-[13px] font-bold text-text-primary truncate">{p.name}</div>
                                            <div className="text-[11px] text-text-tertiary">{KIND_META[p.kind].label}</div>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-1 shrink-0">
                                        <button onClick={() => startEdit(p)} className="p-1.5 rounded-full text-text-tertiary hover:text-text-primary hover:bg-bg-surface" aria-label="Edit preset"><Pencil size={13} /></button>
                                        <button onClick={() => remove(p)} className="p-1.5 rounded-full text-text-tertiary hover:text-red-500 hover:bg-red-500/10" aria-label="Delete preset"><Trash2 size={13} /></button>
                                    </div>
                                </div>
                                <div className="text-[11px] text-text-secondary leading-relaxed">
                                    <div>Mode: <span className="text-text-primary">{modeName(p.modeId)}</span></div>
                                    <div>Resume & JD: <span className="text-text-primary">{p.useProfile ? 'used' : 'off'}</span></div>
                                    <div>Speech: <span className="text-text-primary">you {sttLabel(p.sttLanguage)} · interviewer {p.sttLanguageInterviewer ? sttLabel(p.sttLanguageInterviewer) : 'same'}</span></div>
                                    <div>Answers in: <span className="text-text-primary">{p.aiResponseLanguage === 'auto' ? 'Auto' : p.aiResponseLanguage}</span>{p.sttKeyterms.length > 0 && <> · {p.sttKeyterms.length} key terms</>}</div>
                                </div>
                                <button
                                    onClick={() => apply(p)}
                                    disabled={busyId !== null || isActive}
                                    className={`mt-auto flex items-center justify-center gap-1.5 text-[12px] font-bold rounded-full px-3 py-2 transition-colors ${isActive ? 'bg-accent-primary/15 text-accent-primary cursor-default' : 'bg-text-primary text-bg-main hover:opacity-90'} ${busyId && busyId !== p.id ? 'opacity-50' : ''}`}
                                >
                                    {busyId === p.id ? <Loader2 size={13} className="animate-spin" /> : isActive ? <Check size={13} /> : null}
                                    {isActive ? 'Active' : 'Use this preset'}
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}

            {draft && (
                <div className="rounded-2xl border border-border-subtle bg-bg-input/40 p-4 space-y-4">
                    <div className="flex items-center justify-between">
                        <span className="text-[13px] font-bold text-text-primary">{draft.id ? 'Edit preset' : 'New preset from current setup'}</span>
                        <button onClick={() => setDraft(null)} className="p-1.5 rounded-full text-text-tertiary hover:text-text-primary" aria-label="Cancel"><X size={14} /></button>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                            <label className={labelCls}>Name</label>
                            <input className={fieldCls} value={draft.name} placeholder="e.g. MEXT – JAIST interview" onChange={e => setDraft({ ...draft, name: e.target.value })} />
                        </div>
                        <div>
                            <label className={labelCls}>Type</label>
                            <div className="flex gap-1.5">
                                {(Object.keys(KIND_META) as PresetKind[]).map(k => {
                                    const Icon = KIND_META[k].icon;
                                    return (
                                        <button
                                            key={k}
                                            onClick={() => setDraft({ ...draft, kind: k })}
                                            className={`flex-1 flex items-center justify-center gap-1.5 text-[12px] font-semibold rounded-xl px-2 py-2 border transition-colors ${draft.kind === k ? 'border-accent-primary/60 bg-accent-primary/10 text-text-primary' : 'border-border-subtle text-text-secondary hover:text-text-primary'}`}
                                        >
                                            <Icon size={13} /> {KIND_META[k].label}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                            <label className={labelCls}>Mode (instructions & reference files)</label>
                            <select className={fieldCls} value={draft.modeId ?? ''} onChange={e => setDraft({ ...draft, modeId: e.target.value || null })}>
                                <option value="">No mode</option>
                                {modes.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className={labelCls}>Resume & job description</label>
                            <button
                                onClick={() => setDraft({ ...draft, useProfile: !draft.useProfile })}
                                className="w-full flex items-center justify-between bg-bg-input border border-border-subtle rounded-xl px-3 py-2 text-[13px] text-text-primary"
                            >
                                <span>{draft.useProfile ? 'Use in answers' : 'Do not use'}</span>
                                <span className={`w-9 h-5 rounded-full relative transition-colors ${draft.useProfile ? 'bg-accent-primary' : 'bg-bg-toggle-switch border border-border-muted'}`}>
                                    <span className={`absolute top-1 left-1 w-3 h-3 rounded-full bg-white transition-transform ${draft.useProfile ? 'translate-x-4' : 'translate-x-0'}`} />
                                </span>
                            </button>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                            <label className={labelCls}>My language</label>
                            <select className={fieldCls} value={draft.sttLanguage} onChange={e => setDraft({ ...draft, sttLanguage: e.target.value })}>
                                {sttOptions.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className={labelCls}>Interviewer language</label>
                            <select className={fieldCls} value={draft.sttLanguageInterviewer} onChange={e => setDraft({ ...draft, sttLanguageInterviewer: e.target.value })}>
                                <option value="">Same as mine</option>
                                {sttOptions.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className={labelCls}>Answer language</label>
                            <select className={fieldCls} value={draft.aiResponseLanguage} onChange={e => setDraft({ ...draft, aiResponseLanguage: e.target.value })}>
                                {aiLanguages.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
                            </select>
                        </div>
                    </div>
                    {(draft.sttLanguage === 'auto' || draft.sttLanguageInterviewer === 'auto') && (
                        <p className="text-[11px] text-amber-400 -mt-2">Auto speech detection does not cover Vietnamese on Deepgram. Pick the exact language for a real interview.</p>
                    )}

                    <div>
                        <label className={labelCls}>Notes for the AI (applied with this preset)</label>
                        <textarea
                            className={`${fieldCls} min-h-[80px] resize-y`}
                            maxLength={4000}
                            value={draft.customNotes}
                            placeholder="e.g. Academic panel interview in English. Answer humbly and precisely."
                            onChange={e => setDraft({ ...draft, customNotes: e.target.value })}
                        />
                    </div>

                    <div>
                        <label className={labelCls}>Key terms for speech recognition (comma separated)</label>
                        <textarea
                            className={`${fieldCls} min-h-[56px] resize-y`}
                            value={keytermText}
                            placeholder="Names, acronyms and jargon the interviewer may say, e.g. JAIST, ContractNLI, Kubernetes"
                            onChange={e => setKeytermText(e.target.value)}
                        />
                    </div>

                    <div className="flex justify-end gap-2">
                        <button onClick={() => setDraft(null)} className="text-[12px] font-semibold text-text-secondary px-4 py-2 rounded-full hover:text-text-primary">Cancel</button>
                        <button onClick={saveDraft} className="text-[12px] font-bold bg-text-primary text-bg-main px-4 py-2 rounded-full hover:opacity-90">Save preset</button>
                    </div>
                </div>
            )}
        </div>
    );
}
