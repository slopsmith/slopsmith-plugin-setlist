// Setlist Builder plugin

let _slCurrentId = null;
let _slQueue = [];  // for sequential playback
let _slQueueIndex = -1;

// In-app text prompt — window.prompt() is not implemented in the Electron
// desktop app (it returns null), so the prompt()-based create/rename flows were
// silent no-ops there. Returns the entered string, or null on Esc/Cancel/
// backdrop; Enter submits. Self-contained (no host dependency) and prefixed to
// avoid colliding with other plugins'/the host's globals. Injection-safe:
// caller text is set via textContent/value, never innerHTML.
function slUiPrompt({ title = '', label = '', value = '', okLabel = 'OK', placeholder = '' } = {}) {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.className = 'slopsmith-modal fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        if (title) modal.setAttribute('aria-label', title);
        modal.innerHTML = `
            <form class="bg-dark-700 border border-gray-700 rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl">
                <h3 class="text-lg font-bold text-white mb-4" data-sl-prompt-title hidden></h3>
                <label class="text-xs text-gray-400 mb-1 block" data-sl-prompt-label hidden></label>
                <input type="text" data-sl-prompt-input autocomplete="off"
                    class="w-full bg-dark-600 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-accent/50">
                <div class="flex gap-3 mt-5">
                    <button type="submit"
                        class="flex-1 bg-accent hover:bg-accent-light px-4 py-2 rounded-xl text-sm font-semibold text-white transition" data-sl-prompt-ok></button>
                    <button type="button" data-sl-prompt-cancel
                        class="px-4 py-2 bg-dark-600 hover:bg-dark-500 rounded-xl text-sm text-gray-300 transition">Cancel</button>
                </div>
            </form>`;
        const titleEl = modal.querySelector('[data-sl-prompt-title]');
        const labelEl = modal.querySelector('[data-sl-prompt-label]');
        const input = modal.querySelector('[data-sl-prompt-input]');
        const okEl = modal.querySelector('[data-sl-prompt-ok]');
        if (title) { titleEl.textContent = title; titleEl.hidden = false; }
        if (label) { labelEl.textContent = label; labelEl.hidden = false; }
        okEl.textContent = okLabel;
        input.value = value;
        if (placeholder) input.placeholder = placeholder;

        const previousActiveElement = document.activeElement;
        const focusables = () => Array.from(
            modal.querySelectorAll('input, button, [tabindex]:not([tabindex="-1"])'),
        ).filter((el) => !el.disabled && el.offsetParent !== null);

        let settled = false;
        const close = (result) => {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKey, true);
            modal.remove();
            if (previousActiveElement && typeof previousActiveElement.focus === 'function') {
                previousActiveElement.focus();
            }
            resolve(result);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); return; }
            if (e.key === 'Tab') {
                const items = focusables();
                if (!items.length) return;
                const first = items[0];
                const last = items[items.length - 1];
                const active = document.activeElement;
                if (e.shiftKey && (active === first || !modal.contains(active))) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && (active === last || !modal.contains(active))) { e.preventDefault(); first.focus(); }
            }
        };
        modal.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); close(input.value); });
        modal.querySelector('[data-sl-prompt-cancel]').addEventListener('click', () => close(null));
        modal.addEventListener('mousedown', (e) => { if (e.target === modal) close(null); });
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(modal);
        input.focus();
        input.select();
    });
}

// ── List View ───────────────────────────────────────────────────────────

async function slLoadList() {
    const resp = await fetch('/api/plugins/setlist/list');
    const setlists = await resp.json();
    const container = document.getElementById('sl-list');

    if (setlists.length === 0) {
        container.innerHTML = '<p class="text-gray-500 text-sm">No setlists yet. Create one to get started.</p>';
        return;
    }

    container.innerHTML = setlists.map(s => `
        <div class="flex items-center gap-4 bg-dark-700/50 border border-gray-800/50 rounded-xl p-4 hover:border-accent/20 transition cursor-pointer"
             onclick="slOpenDetail(${s.id})">
            <div class="flex-1 min-w-0">
                <h3 class="text-sm font-semibold text-white">${esc(s.name)}</h3>
                <p class="text-xs text-gray-500 mt-0.5">${s.song_count} song${s.song_count !== 1 ? 's' : ''}</p>
            </div>
            <button onclick="event.stopPropagation();slDelete(${s.id},'${esc(s.name).replace(/'/g,"\\'")}')"
                class="px-2 py-1 text-gray-600 hover:text-red-400 transition text-xs">Delete</button>
        </div>
    `).join('');
}

async function slCreateNew() {
    const name = await slUiPrompt({ title: 'New Setlist', label: 'Setlist name', okLabel: 'Create' });
    if (!name) return;
    await fetch('/api/plugins/setlist/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
    });
    slLoadList();
}

async function slDelete(id, name) {
    if (!confirm(`Delete setlist "${name}"?`)) return;
    await fetch(`/api/plugins/setlist/${id}`, { method: 'DELETE' });
    slLoadList();
}

// ── Detail View ─────────────────────────────────────────────────────────

async function slOpenDetail(id) {
    _slCurrentId = id;
    document.getElementById('sl-list-view').classList.add('hidden');
    document.getElementById('sl-detail-view').classList.remove('hidden');
    document.getElementById('sl-search-results').innerHTML = '';
    document.getElementById('sl-search').value = '';
    await slLoadDetail();
}

function slBackToList() {
    document.getElementById('sl-detail-view').classList.add('hidden');
    document.getElementById('sl-list-view').classList.remove('hidden');
    _slCurrentId = null;
    slLoadList();
}

async function slLoadDetail() {
    const resp = await fetch(`/api/plugins/setlist/${_slCurrentId}`);
    const data = await resp.json();

    document.getElementById('sl-detail-name').textContent = data.name;

    const container = document.getElementById('sl-songs');
    if (data.songs.length === 0) {
        container.innerHTML = '<p class="text-gray-500 text-sm">Empty setlist. Search and add songs above.</p>';
        document.getElementById('sl-play-btn').classList.add('hidden');
        return;
    }

    document.getElementById('sl-play-btn').classList.remove('hidden');

    container.innerHTML = data.songs.map((s, i) => `
        <div class="flex items-center gap-3 bg-dark-700/30 border border-gray-800/30 rounded-lg p-3" data-song-id="${s.id}">
            <span class="text-xs text-gray-600 w-6 text-center">${i + 1}</span>
            <div class="flex-1 min-w-0 cursor-pointer" onclick="playSong('${encodeURIComponent(s.filename)}')">
                <span class="text-sm text-white truncate block hover:text-accent-light transition">${esc(s.title || s.filename)}</span>
                <span class="text-xs text-gray-500">${esc(s.artist || '')}${s.arrangement ? ' · ' + s.arrangement : ''}</span>
            </div>
            <div class="flex gap-1 flex-shrink-0">
                <button onclick="slMove(${s.id},-1)" class="px-2 py-1 text-gray-600 hover:text-white transition text-xs" ${i === 0 ? 'disabled' : ''}>&#9650;</button>
                <button onclick="slMove(${s.id},1)" class="px-2 py-1 text-gray-600 hover:text-white transition text-xs" ${i === data.songs.length - 1 ? 'disabled' : ''}>&#9660;</button>
                <button onclick="slRemoveSong(${s.id})" class="px-2 py-1 text-gray-600 hover:text-red-400 transition text-xs">&#10005;</button>
            </div>
        </div>
    `).join('');
}

async function slRename() {
    const name = await slUiPrompt({ title: 'Rename Setlist', label: 'New name', okLabel: 'Rename' });
    if (!name) return;
    await fetch(`/api/plugins/setlist/${_slCurrentId}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
    });
    slLoadDetail();
}

async function slRemoveSong(songId) {
    await fetch(`/api/plugins/setlist/${_slCurrentId}/song/${songId}`, { method: 'DELETE' });
    slLoadDetail();
}

async function slMove(songId, direction) {
    // Get current order, swap, reorder
    const resp = await fetch(`/api/plugins/setlist/${_slCurrentId}`);
    const data = await resp.json();
    const ids = data.songs.map(s => s.id);
    const idx = ids.indexOf(songId);
    if (idx < 0) return;
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= ids.length) return;
    [ids[idx], ids[newIdx]] = [ids[newIdx], ids[idx]];
    await fetch(`/api/plugins/setlist/${_slCurrentId}/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ song_ids: ids }),
    });
    slLoadDetail();
}

// ── Add songs ───────────────────────────────────────────────────────────

async function slSearchSongs() {
    const q = document.getElementById('sl-search').value.trim();
    if (!q) return;
    const resp = await fetch(`/api/library?q=${encodeURIComponent(q)}&page=0&size=10&sort=artist`);
    const data = await resp.json();
    const container = document.getElementById('sl-search-results');

    if (!data.songs || data.songs.length === 0) {
        container.innerHTML = '<p class="text-gray-500 text-xs py-2">No results</p>';
        return;
    }

    container.innerHTML = data.songs.map(s => {
        const arrs = (s.arrangements || []).map(a => a.name);
        return `<div class="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-dark-700/50 transition">
            <div class="flex-1 min-w-0">
                <span class="text-sm text-white">${esc(s.title)}</span>
                <span class="text-xs text-gray-500 ml-2">${esc(s.artist)}</span>
            </div>
            ${arrs.map(a => `<button onclick="slAddSong('${encodeURIComponent(s.filename)}','${esc(s.title).replace(/'/g,"\\'")}','${esc(s.artist).replace(/'/g,"\\'")}','${a}')"
                class="px-2 py-1 bg-dark-600 hover:bg-accent/30 rounded text-xs text-gray-300 hover:text-white transition">+ ${a}</button>`).join('')}
        </div>`;
    }).join('');
}

async function slAddSong(filename, title, artist, arrangement) {
    await fetch(`/api/plugins/setlist/${_slCurrentId}/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            filename: decodeURIComponent(filename),
            title, artist, arrangement,
        }),
    });
    slLoadDetail();
}

// ── Sequential Playback ─────────────────────────────────────────────────

async function slPlayAll() {
    const resp = await fetch(`/api/plugins/setlist/${_slCurrentId}`);
    const data = await resp.json();
    if (!data.songs || data.songs.length === 0) return;

    _slQueue = data.songs;
    _slQueueIndex = 0;
    _slPlayCurrent();
}

function _slPlayCurrent() {
    if (_slQueueIndex < 0 || _slQueueIndex >= _slQueue.length) {
        _slQueue = [];
        _slQueueIndex = -1;
        return;
    }
    const song = _slQueue[_slQueueIndex];
    playSong(encodeURIComponent(song.filename));

    // Show setlist progress overlay
    _slShowProgress();
}

function _slShowProgress() {
    let overlay = document.getElementById('sl-progress');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'sl-progress';
        overlay.className = 'fixed top-16 right-4 z-50 bg-dark-700/95 border border-gray-700 rounded-xl p-3 shadow-xl max-w-xs';
        document.body.appendChild(overlay);
    }
    const song = _slQueue[_slQueueIndex];
    overlay.innerHTML = `
        <div class="text-xs text-gray-400 mb-2">Setlist: ${_slQueueIndex + 1} / ${_slQueue.length}</div>
        <div class="text-sm text-white mb-1">${esc(song.title || song.filename)}</div>
        <div class="text-xs text-gray-500 mb-3">${esc(song.artist || '')}</div>
        <div class="flex gap-2">
            <button onclick="_slPrev()" class="px-2 py-1 bg-dark-600 hover:bg-dark-500 rounded text-xs text-gray-300 transition" ${_slQueueIndex === 0 ? 'disabled' : ''}>Prev</button>
            <button onclick="_slNext()" class="px-2 py-1 bg-accent hover:bg-accent-light rounded text-xs text-white transition">${_slQueueIndex < _slQueue.length - 1 ? 'Next' : 'Done'}</button>
            <button onclick="_slStopQueue()" class="px-2 py-1 bg-dark-600 hover:bg-red-900/50 rounded text-xs text-gray-400 hover:text-red-400 transition">Stop</button>
        </div>
    `;
}

function _slNext() {
    _slQueueIndex++;
    if (_slQueueIndex >= _slQueue.length) {
        _slStopQueue();
        return;
    }
    _slPlayCurrent();
}

function _slPrev() {
    if (_slQueueIndex > 0) {
        _slQueueIndex--;
        _slPlayCurrent();
    }
}

function _slStopQueue() {
    _slQueue = [];
    _slQueueIndex = -1;
    const overlay = document.getElementById('sl-progress');
    if (overlay) overlay.remove();
}

// ── Hook: auto-advance when song ends ───────────────────────────────────
(function() {
    const audio = document.getElementById('audio');
    if (audio) {
        audio.addEventListener('ended', () => {
            if (_slQueue.length > 0 && _slQueueIndex >= 0) {
                _slNext();
            }
        });
    }
})();

// ── Init: load list when screen shown ───────────────────────────────────
// The showScreen hook is already handled by the plugin loader calling
// the screen JS after injection. We also hook showScreen to reload.
(function() {
    // Idempotency: if screen.js is re-evaluated (loader cache miss, hot reload,
    // older core builds without the load-side guard), don't re-wrap showScreen —
    // each re-wrap captures the previous wrapper, growing the chain and
    // leaking closures.
    const HOOK_KEY = '__slopsmithSetlistHooksInstalled';
    if (window[HOOK_KEY]) return;
    window[HOOK_KEY] = true;

    const origShowScreen = window.showScreen;
    window.showScreen = function(id) {
        origShowScreen(id);
        if (id === 'plugin-setlist') {
            document.getElementById('sl-list-view').classList.remove('hidden');
            document.getElementById('sl-detail-view').classList.add('hidden');
            slLoadList();
        }
    };
})();
