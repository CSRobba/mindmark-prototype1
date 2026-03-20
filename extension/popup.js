const API_URL = "https://v7xq1xy214.execute-api.us-east-1.amazonaws.com/prod/";

// ── Helpers ───────────────────────────────────────────────────────────────────
async function callAPI(body) {
    const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    return response.json();
}

function formatDate(isoString) {
    if (!isoString) return "";
    return new Date(isoString).toLocaleDateString("en-US", {
        month: "short", day: "numeric", year: "numeric"
    });
}

function setStatus(msg, type) {
    const el = document.getElementById("saveStatus");
    el.textContent = msg;
    el.className = `status-msg status-${type}`;
    if (type === "success") setTimeout(() => el.textContent = "", 3000);
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function initTabs() {
    document.querySelectorAll(".tab").forEach(tab => {
        tab.addEventListener("click", () => {
            document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
            tab.classList.add("active");

            document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
            document.getElementById(`tab-${tab.dataset.tab}`).classList.add("active");

            if (tab.dataset.tab === "bookmarks") loadBookmarks();
        });
    });
}

// ── Load current tab info ─────────────────────────────────────────────────────
async function loadCurrentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
        document.getElementById("titleInput").value = tab.title || "";
        document.getElementById("pageUrl").textContent = tab.url || "";
    }
}

// ── Load bookmarks ────────────────────────────────────────────────────────────
async function loadBookmarks() {
    const container = document.getElementById("bookmarksList");
    container.innerHTML = '<p class="empty-msg">Loading...</p>';

    try {
        const data = await callAPI({ action: "list" });
        const bookmarks = data.bookmarks || [];

        if (bookmarks.length === 0) {
            container.innerHTML = '<p class="empty-msg">No bookmarks saved yet</p>';
            return;
        }

        // Sort newest first
        bookmarks.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));

        container.innerHTML = bookmarks.map(b => `
            <div class="bookmark-card" id="card-${b.id}">
                <div class="bookmark-header">
                    <div class="bookmark-title">
                        <a href="${b.url}" target="_blank">${b.title}</a>
                    </div>
                    <button class="btn-delete" data-id="${b.id}" title="Delete">🗑️</button>
                </div>
                ${b.note ? `<div class="bookmark-note">${b.note}</div>` : ""}
                <div class="bookmark-meta">${formatDate(b.savedAt)}</div>
            </div>
        `).join("");

        // Attach delete listeners after rendering
        document.querySelectorAll(".btn-delete").forEach(btn => {
            btn.addEventListener("click", async (e) => {
                const id = e.target.dataset.id;
                e.target.textContent = "...";
                e.target.disabled = true;

                try {
                    await callAPI({ action: "delete", id });

                    // Remove card instantly without reloading whole list
                    document.getElementById(`card-${id}`).remove();

                    // Show empty state if no bookmarks left
                    if (document.querySelectorAll(".bookmark-card").length === 0) {
                        container.innerHTML = '<p class="empty-msg">No bookmarks saved yet</p>';
                    }
                } catch (err) {
                    e.target.textContent = "🗑️";
                    e.target.disabled = false;
                }
            });
        });

    } catch (err) {
        container.innerHTML = '<p class="empty-msg">Failed to load bookmarks</p>';
    }
}

// ── Save bookmark ─────────────────────────────────────────────────────────────
async function saveBookmark() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const title = document.getElementById("titleInput").value.trim();
    const note  = document.getElementById("noteInput").value.trim();
    const btn   = document.getElementById("saveBtn");

    if (!tab?.url) {
        setStatus("Could not get page info", "error");
        return;
    }

    if (!title) {
        setStatus("Please add a title", "error");
        return;
    }

    btn.disabled = true;
    setStatus("Saving...", "loading");

    try {
        await callAPI({
            action: "save",
            url: tab.url,
            title,
            note,
        });

        setStatus("Saved! ✓", "success");
        document.getElementById("noteInput").value = "";

    } catch (err) {
        setStatus("Failed to save", "error");
    } finally {
        btn.disabled = false;
    }
}

// ── Search bookmarks ──────────────────────────────────────────────────────────
async function searchBookmarks() {
    const query     = document.getElementById("searchInput").value.trim();
    const container = document.getElementById("searchResults");

    if (!query) {
        container.innerHTML = "";
        return;
    }

    container.innerHTML = '<p class="empty-msg status-loading">Asking Claude...</p>';

    try {
        const data    = await callAPI({ action: "search", query });
        const results = data.results || [];

        if (results.length === 0 || typeof results === "string") {
            container.innerHTML = '<p class="empty-msg">No relevant bookmarks found</p>';
            return;
        }

        container.innerHTML = results.map(r => `
            <div class="result-card">
                <div class="result-title">
                    <a href="${r.url}" target="_blank">${r.title}</a>
                </div>
                <div class="result-reason">${r.reason}</div>
                <div class="result-url">${r.url}</div>
            </div>
        `).join("");

    } catch (err) {
        container.innerHTML = '<p class="empty-msg">Search failed</p>';
    }
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
    initTabs();
    loadCurrentTab();

    document.getElementById("saveBtn").addEventListener("click", saveBookmark);
    document.getElementById("refreshBtn").addEventListener("click", loadBookmarks);
    document.getElementById("searchBtn").addEventListener("click", searchBookmarks);
    document.getElementById("searchInput").addEventListener("keydown", (e) => {
        if (e.key === "Enter") searchBookmarks();
    });
});