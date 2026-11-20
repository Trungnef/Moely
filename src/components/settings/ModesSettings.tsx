import React, { useEffect, useMemo, useState } from 'react';
import { Check, FileText, Plus, RefreshCw, Trash2, Upload, X } from 'lucide-react';

type ModeRow = {
  id: string;
  name: string;
  templateType?: string;
  template_type?: string;
  customContext?: string;
  custom_context?: string;
  isActive?: boolean;
  is_active?: number;
  referenceFileCount?: number;
};

type RefFile = {
  id: string;
  fileName?: string;
  file_name?: string;
};

type ModesSettingsProps = {
  onClose?: () => void;
  isPremium?: boolean;
  isLoaded?: boolean;
  isTrialActive?: boolean;
  onOpenNativelyAPI?: () => void;
};

export default function ModesSettings({ onClose }: ModesSettingsProps) {
  const [modes, setModes] = useState<ModeRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refs, setRefs] = useState<RefFile[]>([]);
  const [name, setName] = useState('');
  const [templateType, setTemplateType] = useState('general');
  const [customContext, setCustomContext] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const selectedMode = useMemo(
    () => modes.find((mode) => mode.id === selectedId) || modes[0] || null,
    [modes, selectedId],
  );

  const normalizeMode = (mode: ModeRow) => ({
    ...mode,
    templateType: mode.templateType || mode.template_type || 'general',
    customContext: mode.customContext || mode.custom_context || '',
    isActive: mode.isActive ?? mode.is_active === 1,
  });

  const loadModes = async () => {
    setLoading(true);
    setError('');
    try {
      const rows = (await window.electronAPI?.modesGetAll?.()) || [];
      const normalized = rows.map(normalizeMode);
      setModes(normalized);
      const active = normalized.find((mode) => mode.isActive) || (await window.electronAPI?.modesGetActive?.());
      const nextActiveId = active?.id || null;
      setActiveId(nextActiveId);
      setSelectedId((prev) => prev && normalized.some((mode) => mode.id === prev) ? prev : (nextActiveId || normalized[0]?.id || null));
    } catch (err: any) {
      setError(err?.message || 'Failed to load modes');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadModes();
  }, []);

  useEffect(() => {
    if (!selectedMode) {
      setName('');
      setTemplateType('general');
      setCustomContext('');
      setRefs([]);
      return;
    }
    setName(selectedMode.name || '');
    setTemplateType(selectedMode.templateType || 'general');
    setCustomContext(selectedMode.customContext || '');
    window.electronAPI?.modesGetReferenceFiles?.(selectedMode.id)
      .then((files) => setRefs(files || []))
      .catch(() => setRefs([]));
  }, [selectedMode?.id]);

  const createMode = async () => {
    setSaving(true);
    setError('');
    try {
      const result = await window.electronAPI?.modesCreate?.({ name: 'New Mode', templateType: 'general' });
      if (!result?.success) throw new Error(result?.error || 'Failed to create mode');
      await loadModes();
      if (result.mode?.id) setSelectedId(result.mode.id);
    } catch (err: any) {
      setError(err?.message || 'Failed to create mode');
    } finally {
      setSaving(false);
    }
  };

  const saveMode = async () => {
    if (!selectedMode) return;
    setSaving(true);
    setError('');
    try {
      const result = await window.electronAPI?.modesUpdate?.(selectedMode.id, {
        name: name.trim() || 'Untitled Mode',
        templateType,
        customContext,
      });
      if (!result?.success) throw new Error(result?.error || 'Failed to save mode');
      await loadModes();
    } catch (err: any) {
      setError(err?.message || 'Failed to save mode');
    } finally {
      setSaving(false);
    }
  };

  const activateMode = async (id: string | null) => {
    const result = await window.electronAPI?.modesSetActive?.(id);
    if (result?.success) {
      setActiveId(id);
      await loadModes();
    } else {
      setError(result?.error || 'Failed to activate mode');
    }
  };

  const deleteMode = async () => {
    if (!selectedMode || selectedMode.id === 'general') return;
    if (!confirm(`Delete "${selectedMode.name}"?`)) return;
    const result = await window.electronAPI?.modesDelete?.(selectedMode.id);
    if (result?.success) {
      setSelectedId(null);
      await loadModes();
    } else {
      setError(result?.error || 'Failed to delete mode');
    }
  };

  const uploadReference = async () => {
    if (!selectedMode) return;
    const result = await window.electronAPI?.modesUploadReferenceFile?.(selectedMode.id);
    if (result?.success) {
      const files = await window.electronAPI?.modesGetReferenceFiles?.(selectedMode.id);
      setRefs(files || []);
      await loadModes();
    } else if (!result?.cancelled) {
      setError(result?.error || 'Failed to upload reference');
    }
  };

  return (
    <div className="h-full w-full bg-bg-main text-text-primary flex flex-col">
      <div className="h-16 shrink-0 border-b border-border-subtle px-5 flex items-center justify-between bg-bg-surface/70">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight">Modes</h2>
          <p className="text-[11px] text-text-tertiary mt-0.5">Prompt presets, reference files, and custom context</p>
        </div>
        <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-bg-input" aria-label="Close">
          <X size={16} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="w-64 border-r border-border-subtle bg-bg-sidebar p-3 flex flex-col gap-2">
          <button onClick={createMode} disabled={saving} className="h-9 rounded-lg bg-accent-primary text-white text-xs font-semibold flex items-center justify-center gap-2 disabled:opacity-60">
            <Plus size={14} /> New Mode
          </button>
          <button onClick={() => activateMode(null)} className="h-8 rounded-lg text-xs text-text-secondary hover:text-text-primary hover:bg-bg-input flex items-center justify-center gap-2">
            <X size={13} /> Clear Active
          </button>
          <div className="overflow-y-auto min-h-0 flex-1 space-y-1 pt-2">
            {loading ? (
              <div className="text-xs text-text-tertiary flex items-center gap-2 px-2 py-3"><RefreshCw size={13} className="animate-spin" /> Loading modes</div>
            ) : modes.map((mode) => (
              <button
                key={mode.id}
                onClick={() => setSelectedId(mode.id)}
                className={`w-full text-left rounded-lg px-3 py-2 border transition-colors ${selectedMode?.id === mode.id ? 'bg-bg-item-active border-border-muted' : 'border-transparent hover:bg-bg-input'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold truncate">{mode.name}</span>
                  {activeId === mode.id && <Check size={13} className="text-emerald-400 shrink-0" />}
                </div>
                <div className="text-[10px] text-text-tertiary mt-1 truncate">
                  {mode.templateType || 'general'} · {mode.referenceFileCount || 0} refs
                </div>
              </button>
            ))}
          </div>
        </aside>

        <main className="flex-1 min-w-0 overflow-y-auto p-5">
          {error && <div className="mb-3 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>}
          {!selectedMode ? (
            <div className="h-full flex items-center justify-center text-sm text-text-tertiary">Create or select a mode.</div>
          ) : (
            <div className="max-w-2xl space-y-4">
              <div className="rounded-lg border border-border-subtle bg-bg-input p-4 space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <label className="space-y-1.5">
                    <span className="text-[10px] uppercase tracking-wide text-text-tertiary font-semibold">Name</span>
                    <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-lg border border-border-subtle bg-bg-main px-3 py-2 text-xs outline-none focus:border-accent-primary/60" />
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-[10px] uppercase tracking-wide text-text-tertiary font-semibold">Template</span>
                    <select value={templateType} onChange={(e) => setTemplateType(e.target.value)} className="w-full rounded-lg border border-border-subtle bg-bg-main px-3 py-2 text-xs outline-none focus:border-accent-primary/60">
                      {['general', 'sales', 'recruiting', 'team-meet', 'looking-for-work', 'technical-interview', 'lecture'].map((template) => (
                        <option key={template} value={template}>{template}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="space-y-1.5 block">
                  <span className="text-[10px] uppercase tracking-wide text-text-tertiary font-semibold">Custom Context</span>
                  <textarea value={customContext} onChange={(e) => setCustomContext(e.target.value)} rows={7} className="w-full rounded-lg border border-border-subtle bg-bg-main px-3 py-2 text-xs leading-relaxed outline-none resize-none focus:border-accent-primary/60" />
                </label>
                <div className="flex items-center gap-2 justify-end">
                  {selectedMode.id !== 'general' && (
                    <button onClick={deleteMode} className="h-8 px-3 rounded-lg border border-red-500/20 text-red-400 hover:bg-red-500/10 text-xs font-medium flex items-center gap-1.5">
                      <Trash2 size={13} /> Delete
                    </button>
                  )}
                  <button onClick={() => activateMode(selectedMode.id)} className="h-8 px-3 rounded-lg border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-main text-xs font-medium">
                    Set Active
                  </button>
                  <button onClick={saveMode} disabled={saving} className="h-8 px-3 rounded-lg bg-accent-primary text-white text-xs font-semibold disabled:opacity-60">
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>

              <div className="rounded-lg border border-border-subtle bg-bg-input p-4">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h3 className="text-xs font-semibold">Reference Files</h3>
                    <p className="text-[10px] text-text-tertiary mt-0.5">Attached documents are injected into this mode's AI context.</p>
                  </div>
                  <button onClick={uploadReference} className="h-8 px-3 rounded-lg border border-border-subtle hover:bg-bg-main text-xs font-medium flex items-center gap-1.5">
                    <Upload size={13} /> Upload
                  </button>
                </div>
                <div className="space-y-2">
                  {refs.length === 0 ? (
                    <div className="text-xs text-text-tertiary py-3">No reference files yet.</div>
                  ) : refs.map((file) => (
                    <div key={file.id} className="flex items-center justify-between rounded-lg bg-bg-main border border-border-subtle px-3 py-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <FileText size={14} className="text-text-tertiary shrink-0" />
                        <span className="text-xs truncate">{file.fileName || file.file_name || 'Reference file'}</span>
                      </div>
                      <button
                        onClick={async () => {
                          await window.electronAPI?.modesDeleteReferenceFile?.(file.id);
                          if (selectedMode) setRefs((await window.electronAPI?.modesGetReferenceFiles?.(selectedMode.id)) || []);
                          await loadModes();
                        }}
                        className="w-7 h-7 rounded-md flex items-center justify-center text-text-tertiary hover:text-red-400 hover:bg-red-500/10"
                        aria-label="Delete reference file"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
