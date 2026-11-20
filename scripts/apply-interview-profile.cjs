/**
 * Apply (or restore) an interview "context pack" to the local Natively app state.
 *
 * A pack is a folder with a profile.json manifest (see data/<pack>/profile.json):
 * a dedicated Mode (custom instructions + reference files), custom notes, STT /
 * answer languages, auto-answer settings and STT keyterms. Before changing
 * anything the script writes a backup that --restore can put back.
 *
 * The app must be CLOSED (it caches credentials/settings in memory and would
 * overwrite these changes on exit). Requires `npm run build:electron` first.
 *
 *   npx electron scripts/apply-interview-profile.cjs data/mext_interview
 *   npx electron scripts/apply-interview-profile.cjs --restore data/mext_interview/backup-<ts>.json
 *
 * (From a VS Code terminal unset ELECTRON_RUN_AS_NODE first, or Electron runs as plain Node.)
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const userData = path.join(process.env.APPDATA || path.join(require('os').homedir(), '.config'), 'natively');
app.setPath('userData', userData);

const args = process.argv.slice(process.argv.findIndex(a => a.endsWith('apply-interview-profile.cjs')) + 1);
const restoreIdx = args.indexOf('--restore');

function fail(msg) {
    console.error(`\n✖ ${msg}`);
    app.exit(1);
}

function appIsRunning() {
    if (process.platform !== 'win32') return false;
    try {
        const out = execSync('tasklist /FO CSV /NH', { encoding: 'utf8' });
        return /"Natively\.exe"/i.test(out);
    } catch { return false; }
}

function load(rel) {
    return require(path.join(repoRoot, 'dist-electron', 'electron', rel));
}

app.whenReady().then(() => {
    try {
        if (appIsRunning()) return fail('Natively is running. Quit it completely, then run this script again.');
        if (!fs.existsSync(path.join(repoRoot, 'dist-electron', 'electron', 'main.js'))) {
            return fail('dist-electron not found. Run `npm run build:electron` first.');
        }

        const { DatabaseManager } = load('db/DatabaseManager.js');
        const { ModesManager } = load('services/ModesManager.js');
        const { CredentialsManager } = load('services/CredentialsManager.js');
        const { SettingsManager } = load('services/SettingsManager.js');

        const db = DatabaseManager.getInstance();
        const modes = ModesManager.getInstance();
        const creds = CredentialsManager.getInstance();
        creds.init();
        const settings = SettingsManager.getInstance();

        if (restoreIdx !== -1) {
            const file = args[restoreIdx + 1];
            if (!file || !fs.existsSync(file)) return fail('Usage: --restore <backup.json>');
            const b = JSON.parse(fs.readFileSync(file, 'utf8'));
            modes.setActiveMode(b.activeModeId ?? null);
            db.setAppState('persona:mode', b.personaMode ?? '0');
            db.saveCustomNotes(b.customNotes ?? '');
            creds.setSttLanguage(b.sttLanguage || 'english-us');
            creds.setSttLanguageInterviewer(b.sttLanguageInterviewer || '');
            creds.setAiResponseLanguage(b.aiResponseLanguage || 'auto');
            for (const [k, v] of Object.entries(b.settings || {})) settings.set(k, v === null ? undefined : v);
            console.log(`\n✔ Restored state from ${file}`);
            console.log('  (The interview Mode itself is kept; delete it in Settings → Modes if you no longer need it.)');
            return app.exit(0);
        }

        const packDir = path.resolve(args[0] || '');
        const manifestPath = path.join(packDir, 'profile.json');
        if (!args[0] || !fs.existsSync(manifestPath)) return fail('Usage: apply-interview-profile.cjs <packDir with profile.json>');
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const read = (f) => fs.readFileSync(path.join(packDir, f), 'utf8').trim();

        // ── Backup ──────────────────────────────────────────────────────────
        const settingKeys = Object.keys(m.settings || {}).concat('sttKeyterms');
        const backup = {
            createdAt: new Date().toISOString(),
            activeModeId: modes.getActiveMode()?.id ?? null,
            personaMode: db.getAppState('persona:mode'),
            customNotes: db.getCustomNotes(),
            sttLanguage: creds.getSttLanguage(),
            sttLanguageInterviewer: creds.getSttLanguageInterviewerOverride(),
            aiResponseLanguage: creds.getAiResponseLanguage(),
            settings: Object.fromEntries(settingKeys.map(k => [k, settings.get(k) ?? null])),
        };
        const backupPath = path.join(packDir, `backup-${backup.createdAt.replace(/[:.]/g, '-')}.json`);
        fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));

        // ── Mode: create or update in place (idempotent by name) ────────────
        let mode = modes.getModes().find(x => x.name === m.modeName);
        if (!mode) mode = modes.createMode({ name: m.modeName, templateType: m.templateType || 'looking-for-work' });
        modes.updateMode(mode.id, {
            templateType: m.templateType || 'looking-for-work',
            customContext: m.customInstructionsFile ? read(m.customInstructionsFile) : '',
        });
        for (const f of modes.getReferenceFiles(mode.id)) modes.deleteReferenceFile(f.id);
        for (const f of m.referenceFiles || []) {
            modes.addReferenceFile({ modeId: mode.id, fileName: f, content: read(f) });
        }
        modes.setActiveMode(mode.id);

        // ── Profile / notes ─────────────────────────────────────────────────
        // Profile Mode injects the stored resume/JD/company dossier into answers;
        // turn it off when that material belongs to a different interview.
        if (m.disableProfileMode) db.setAppState('persona:mode', '0');
        if (typeof m.customNotes === 'string') db.saveCustomNotes(m.customNotes);

        // ── Languages ───────────────────────────────────────────────────────
        if (m.sttLanguage) creds.setSttLanguage(m.sttLanguage);
        if (m.sttLanguageInterviewer !== undefined) creds.setSttLanguageInterviewer(m.sttLanguageInterviewer);
        if (m.aiResponseLanguage) creds.setAiResponseLanguage(m.aiResponseLanguage);

        // ── Settings ────────────────────────────────────────────────────────
        for (const [k, v] of Object.entries(m.settings || {})) settings.set(k, v);
        if (Array.isArray(m.sttKeyterms)) settings.set('sttKeyterms', m.sttKeyterms);

        // ── Verify by reading back ──────────────────────────────────────────
        const block = modes.buildActiveModeContextBlock();
        const active = modes.getActiveMode();
        console.log(`\n✔ Applied pack "${m.modeName}"`);
        console.log(`  Active mode     : ${active?.name} (${active?.templateType})`);
        console.log(`  Reference files : ${modes.getReferenceFiles(mode.id).map(f => `${f.fileName} (${f.content.length} chars)`).join(', ')}`);
        console.log(`  Context block   : ${block.length} chars${block.includes('[...truncated]') ? '  ⚠ TRUNCATED' : ''}`);
        console.log(`  STT language    : mic=${creds.getSttLanguage()}  interviewer=${creds.getSttLanguageInterviewer()}  provider=${creds.getSttProvider()}`);
        console.log(`  Answer language : ${creds.getAiResponseLanguage()}`);
        console.log(`  Profile mode    : ${db.getAppState('persona:mode') === '1' ? 'on' : 'off'}`);
        console.log(`  Auto-answer     : ${settings.get('autoReplyOnFinal') !== false ? 'on' : 'off'}, early answers: ${settings.get('speculativeAnswers') ? 'on' : 'off'}`);
        console.log(`  STT keyterms    : ${(settings.get('sttKeyterms') || []).length}`);
        console.log(`  Backup          : ${backupPath}`);
        app.exit(0);
    } catch (err) {
        fail(err && err.stack || String(err));
    }
});
