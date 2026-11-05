// alchemy_backup.js: Export / import all calculator data (every "alchemy_" localStorage key) as one JSON file.
// File format is shared with backup.html: { format: "alchemy-backup", version: 1, createdAt, origin, data: { key: string } }

(function () {
    const PREFIX = 'alchemy_';
    const MODAL_ID = 'backup-modal';
    const LABELS = {
        alchemy_planner_library_v1: 'Planner plans',
        alchemy_planner_settings_v1: 'Planner settings',
        alchemy_cauldron_v1: 'Cauldron recipes',
        alchemy_factory_save_v1: 'Recipe database (active)',
        alchemy_source_v1: 'Database editor source',
        alchemy_source_backup_v1: 'Database editor backup',
        alchemy_settings_v1: 'Settings',
        alchemy_settings_backup_v1: 'Settings backup',
        alchemy_i18n_source_v1: 'Translations',
        alchemy_i18n_source_backup_v1: 'Translations backup'
    };
    let pending = null;

    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const fmtSize = n => n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB';

    function collect() {
        const d = {};
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(PREFIX)) d[k] = localStorage.getItem(k);
        }
        return d;
    }

    function planCount(raw) {
        try { const p = JSON.parse(raw); return p && p.plans ? Object.keys(p.plans).length : null; }
        catch (e) { return null; }
    }

    function table(d) {
        const keys = Object.keys(d).sort();
        if (!keys.length) return '<p style="color:#999">No calculator data found.</p>';
        let h = '<table class="backup-table"><tr><th>Data</th><th>Key</th><th style="text-align:right">Size</th></tr>';
        for (const k of keys) {
            let label = LABELS[k] || '';
            if (k === 'alchemy_planner_library_v1') {
                const n = planCount(d[k]);
                if (n !== null) label += ` (${n} plan${n === 1 ? '' : 's'})`;
            }
            h += `<tr><td>${esc(label)}</td><td><code>${esc(k)}</code></td><td style="text-align:right">${fmtSize((d[k] || '').length)}</td></tr>`;
        }
        return h + '</table>';
    }

    function download(d, suffix) {
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const payload = {
            format: 'alchemy-backup', version: 1, createdAt: new Date().toISOString(),
            origin: location.origin + location.pathname, data: d
        };
        const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'alchemy_backup_' + stamp + (suffix || '') + '.json';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    // Accepts the backup format above, or a plain { "alchemy_x": "..." } object.
    function parseBackup(text) {
        const obj = JSON.parse(text);
        const src = obj && obj.format === 'alchemy-backup' && obj.data ? obj.data : obj;
        if (!src || typeof src !== 'object' || Array.isArray(src)) throw new Error('Not a backup file.');
        const d = {};
        for (const k in src) {
            if (!k.startsWith(PREFIX)) continue;
            d[k] = typeof src[k] === 'string' ? src[k] : JSON.stringify(src[k]);
        }
        if (!Object.keys(d).length) throw new Error('The file contains no calculator data.');
        return { data: d, createdAt: obj.createdAt || null };
    }

    function msg(cls, text) {
        const el = document.getElementById('backup-msg');
        el.className = 'backup-msg ' + cls;
        el.textContent = text;
    }

    function buildModal() {
        if (document.getElementById(MODAL_ID)) return;
        const wrap = document.createElement('div');
        wrap.id = MODAL_ID;
        wrap.className = 'modal-overlay';
        wrap.onclick = () => closeModal(MODAL_ID);
        wrap.innerHTML = `
            <div class="modal-content" onclick="event.stopPropagation()" style="max-width:640px;">
                <div class="modal-header">
                    <h2 style="font-size:1.1em; margin:0;">💾 Backup &amp; Restore</h2>
                    <button class="close-modal" onclick="closeModal('${MODAL_ID}')">&times;</button>
                </div>
                <p class="backup-note">Saves your planner plans, cauldron recipes, settings and database edits to a file,
                    or loads them back. Keep a backup before updating or moving to another computer/browser.</p>
                <h3 class="backup-h">Current data</h3>
                <div id="backup-current"></div>
                <button class="backup-btn export" id="backup-export-btn">⬇ Export backup file</button>

                <h3 class="backup-h">Import</h3>
                <label class="backup-btn import" for="backup-file">⬆ Choose backup file…</label>
                <input type="file" id="backup-file" accept=".json,application/json" hidden>
                <div id="backup-preview"></div>
                <div id="backup-restore-controls" style="display:none">
                    <label class="backup-check"><input type="checkbox" id="backup-opt-clear">
                        <span>Also remove current data that isn't in the file (exact copy of the backup)</span></label>
                    <p class="backup-note">A safety copy of your current data downloads first, then the page reloads.</p>
                    <button class="backup-btn danger" id="backup-restore-btn">Restore this backup</button>
                </div>
                <div id="backup-msg" class="backup-msg"></div>
            </div>`;
        document.body.appendChild(wrap);

        document.getElementById('backup-export-btn').onclick = () => {
            const d = collect();
            if (!Object.keys(d).length) { msg('err', 'Nothing to export yet.'); return; }
            download(d);
            msg('ok', `Backup downloaded (${Object.keys(d).length} entries).`);
        };

        document.getElementById('backup-file').onchange = e => {
            const f = e.target.files[0];
            e.target.value = '';
            pending = null;
            document.getElementById('backup-preview').innerHTML = '';
            document.getElementById('backup-restore-controls').style.display = 'none';
            document.getElementById('backup-msg').className = 'backup-msg';
            if (!f) return;
            const r = new FileReader();
            r.onload = () => {
                try {
                    pending = parseBackup(r.result);
                    const when = pending.createdAt ? ', created ' + new Date(pending.createdAt).toLocaleString() : '';
                    document.getElementById('backup-preview').innerHTML =
                        `<p class="backup-note"><b>${esc(f.name)}</b>${esc(when)}:</p>` + table(pending.data);
                    document.getElementById('backup-restore-controls').style.display = 'block';
                } catch (err) {
                    msg('err', 'Could not read file: ' + err.message);
                }
            };
            r.readAsText(f);
        };

        document.getElementById('backup-restore-btn').onclick = restore;
    }

    function restore() {
        if (!pending) return;
        const n = Object.keys(pending.data).length;
        const clear = document.getElementById('backup-opt-clear').checked;
        if (!confirm(`Restore ${n} entries${clear ? ' and remove other calculator data' : ''}?\n` +
                     'A safety copy of your current data will be downloaded first, then the page reloads.')) return;

        const current = collect();
        if (Object.keys(current).length) download(current, '_before-restore');

        try {
            if (clear) for (const k in current) if (!(k in pending.data)) localStorage.removeItem(k);
            for (const k in pending.data) localStorage.setItem(k, pending.data[k]);
        } catch (err) {
            msg('err', 'Restore failed: ' + err.message + '. Your safety copy was downloaded.');
            return;
        }

        // The running app still holds the old data in memory; block its pending saves so they
        // can't overwrite the restored data before the reload.
        const origSet = Storage.prototype.setItem;
        Storage.prototype.setItem = function (k, v) {
            if (this === localStorage && String(k).startsWith(PREFIX)) return;
            return origSet.call(this, k, v);
        };
        msg('ok', `Restored ${n} entries. Reloading…`);
        // Small delay so the safety-copy download starts before navigation.
        setTimeout(() => location.reload(), 600);
    }

    window.openBackupModal = function () {
        buildModal();
        pending = null;
        document.getElementById('backup-current').innerHTML = table(collect());
        document.getElementById('backup-preview').innerHTML = '';
        document.getElementById('backup-restore-controls').style.display = 'none';
        document.getElementById('backup-msg').className = 'backup-msg';
        document.getElementById(MODAL_ID).style.display = 'flex';
    };
})();
