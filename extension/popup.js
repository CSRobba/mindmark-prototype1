/* ============================================================
   MindMark — popup.js
   Handles all UI logic: tabs, save, search, library, delete
   Search results persist in memory until user clears the input
   ============================================================ */

const API_URL = "https://v7xq1xy214.execute-api.us-east-1.amazonaws.com/prod/";

// In-memory cache of the last search so results survive
// tab switching and clicking away from the extension
let lastQuery   = "";
let lastResults = [];

// ── API helper ────────────────────────────────────────────────
// Single function for all backend calls — keeps fetch logic in one place
async function callAPI(body) {
    const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    return response.json();
}

// ── Utilities ─────────────────────────────────────────────────
function formatDate(isoString) {
    if (!isoString) return "";
    return new Date(isoString).toLocaleDateString("en-US", {
        month: "short", day: "numeric", year: "numeric"
    });
}

// Show a status message below the save button
// type: "success" | "error" | "loading"
function setStatus(msg, type) {
    const el = document.getElementById("saveStatus");
    el.textContent = msg;
    el.className = `status-msg status-${type}`;
    if (type === "success") setTimeout(() => el.textContent = "", 3000);
}

// Build the HTML for a single result card including relevance bar
// Used both when rendering fresh results and when restoring from cache
function buildResultCard(r) {
    const score = r.score ?? null;
    return `
        <div class="result-card">
            <div class="result-header">
                <div class="result-title">
                    <a href="${r.url}" target="_blank" title="${r.title}">${r.title}</a>
                </div>
                ${score !== null
                    ? `<span class="result-score-label">${score}%</span>`
                    : ""}
            </div>
            ${score !== null ? `
            <div class="relevance-bar-wrap">
                <div class="relevance-bar" style="width:${score}%"></div>
            </div>` : ""}
            <div class="result-reason">${r.reason}</div>
            <div class="result-url">${r.url}</div>
        </div>
    `;
}

// ── Tab switching ─────────────────────────────────────────────
// Switches between Save and Library panels
// Restores previous search results when switching back to Save tab
function initTabs() {
    document.querySelectorAll(".tab").forEach(tab => {
        tab.addEventListener("click", () => {
            // Deactivate all tabs and panels
            document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
            document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));

            // Activate the clicked tab and its panel
            tab.classList.add("active");
            document.getElementById(`tab-${tab.dataset.tab}`).classList.add("active");

            if (tab.dataset.tab === "bookmarks") {
                // Load library when switching to it
                loadBookmarks();
            }

            if (tab.dataset.tab === "save") {
                // Restore previous search state so results aren't lost
                // when the user switches tabs or clicks away
                if (lastQuery) {
                    document.getElementById("searchInput").value = lastQuery;
                    if (lastResults.length > 0) {
                        const container = document.getElementById("searchResults");
                        container.innerHTML = lastResults.map(buildResultCard).join("");
                    }
                }
            }
        });
    });
}

// ── Current tab ───────────────────────────────────────────────
// Pre-fills title and URL from the active Chrome tab when popup opens
async function loadCurrentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
        document.getElementById("titleInput").value = tab.title || "";
        document.getElementById("pageUrl").textContent = tab.url || "";
    }
}

// ── Library ───────────────────────────────────────────────────
// Fetches all bookmarks from DynamoDB and renders them as cards
// Also builds the tag filter bar from all unique tags
async function loadBookmarks() {
    const container = document.getElementById("bookmarksList");
    container.innerHTML = '<p class="empty-msg">Loading...</p>';

    try {
        const data      = await callAPI({ action: "list" });
        const bookmarks = data.bookmarks || [];

        if (bookmarks.length === 0) {
            container.innerHTML = '<p class="empty-msg">No bookmarks saved yet</p>';
            document.getElementById("tagFilterBar").classList.add("hidden");
            return;
        }

        // Sort newest first
        bookmarks.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));

        // Build tag filter bar from all unique tags across all bookmarks
        renderTagFilterBar(bookmarks);

        // Render bookmark cards
        renderBookmarkCards(bookmarks);

    } catch (err) {
        container.innerHTML = '<p class="empty-msg">Failed to load bookmarks</p>';
    }
}

// Renders the tag filter pills above the bookmark list.
// Supports multi-select — clicking multiple tags shows bookmarks
// matching ANY of the selected tags. Clicking All resets everything.
function renderTagFilterBar(bookmarks) {
    const bar = document.getElementById("tagFilterBar");

    // Collect all unique tags across all bookmarks, sorted alphabetically
    const allTags = [...new Set(
        bookmarks.flatMap(b => b.tags || [])
    )].sort();

    if (allTags.length === 0) {
        bar.classList.add("hidden");
        return;
    }

    bar.classList.remove("hidden");
    bar.innerHTML = `
        <button class="tag-filter-pill all-pill active" data-tag="all">All</button>
        ${allTags.map(tag => `
            <button class="tag-filter-pill" data-tag="${tag}">${tag}</button>
        `).join("")}
    `;

    // Track which tags are currently selected
    let selectedTags = new Set();

    bar.querySelectorAll(".tag-filter-pill").forEach(pill => {
        pill.addEventListener("click", () => {
            const clickedTag = pill.dataset.tag;

            if (clickedTag === "all") {
                // Reset — clear all selections and show every bookmark
                selectedTags.clear();
                bar.querySelectorAll(".tag-filter-pill").forEach(p => p.classList.remove("active"));
                pill.classList.add("active");
            } else {
                // Deactivate the All pill since we're now filtering
                bar.querySelector(".all-pill").classList.remove("active");

                // Toggle this tag — click again to deselect
                if (selectedTags.has(clickedTag)) {
                    selectedTags.delete(clickedTag);
                    pill.classList.remove("active");
                } else {
                    selectedTags.add(clickedTag);
                    pill.classList.add("active");
                }

                // If user deselected everything, fall back to showing all
                if (selectedTags.size === 0) {
                    bar.querySelector(".all-pill").classList.add("active");
                }
            }

            // Apply filter — show cards matching ANY selected tag
            document.querySelectorAll(".bookmark-card").forEach(card => {
                if (selectedTags.size === 0) {
                    card.style.display = "block";
                } else {
                    const cardTags = card.dataset.tags
                        ? card.dataset.tags.split(",").filter(Boolean)
                        : [];
                    const hasMatch = [...selectedTags].some(t => cardTags.includes(t));
                    card.style.display = hasMatch ? "block" : "none";
                }
            });
        });
    });
}

// Renders all bookmark cards into the list container
// Stores tags as a data attribute so the filter can read them
function renderBookmarkCards(bookmarks) {
    const container = document.getElementById("bookmarksList");

    container.innerHTML = bookmarks.map(b => {
        const tags = b.tags || [];
        return `
            <div class="bookmark-card" id="card-${b.id}" data-tags="${tags.join(",")}">
                <div class="bookmark-header">
                    <div class="bookmark-title">
                        <a href="${b.url}" target="_blank" title="${b.title}">${b.title}</a>
                    </div>
                    <button class="btn-delete" data-id="${b.id}" title="Delete">🗑️</button>
                </div>
                ${b.note ? `<div class="bookmark-note">${b.note}</div>` : ""}
                <div class="bookmark-footer">
                    <div class="bookmark-tags">
                        ${tags.map(tag => `<span class="tag-pill">${tag}</span>`).join("")}
                    </div>
                    <span class="bookmark-meta">${formatDate(b.savedAt)}</span>
                </div>
            </div>
        `;
    }).join("");

    // Attach delete listeners after rendering
    // (can't attach before because the elements don't exist yet)
    container.querySelectorAll(".btn-delete").forEach(btn => {
        btn.addEventListener("click", async (e) => {
            const id = e.target.dataset.id;
            e.target.textContent = "...";
            e.target.disabled = true;

            try {
                await callAPI({ action: "delete", id });

                // Remove card from DOM instantly — no need to re-fetch the list
                document.getElementById(`card-${id}`).remove();

                // Show empty state if no cards remain
                if (!document.querySelector(".bookmark-card")) {
                    container.innerHTML = '<p class="empty-msg">No bookmarks saved yet</p>';
                    document.getElementById("tagFilterBar").classList.add("hidden");
                }
            } catch (err) {
                e.target.textContent = "🗑️";
                e.target.disabled = false;
            }
        });
    });
}

// ── Save ──────────────────────────────────────────────────────
// Reads the current tab URL + user-edited title + optional note
// and writes a new bookmark to DynamoDB via Lambda
async function saveBookmark() {
    const [tab]  = await chrome.tabs.query({ active: true, currentWindow: true });
    const title  = document.getElementById("titleInput").value.trim();
    const note   = document.getElementById("noteInput").value.trim();
    const btn    = document.getElementById("saveBtn");

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
        await callAPI({ action: "save", url: tab.url, title, note });
        setStatus("Saved", "success");
        document.getElementById("noteInput").value = "";

    } catch (err) {
        setStatus("Failed to save", "error");
    } finally {
        btn.disabled = false;
    }
}

// ── Search ────────────────────────────────────────────────────
// Sends query to Lambda → DynamoDB fetch → Claude ranking
// Results are cached in lastQuery/lastResults so they survive
// tab switching and clicking away from the extension popup
async function searchBookmarks() {
    const query     = document.getElementById("searchInput").value.trim();
    const container = document.getElementById("searchResults");

    // Don't wipe results if user submitted an empty query —
    // let them keep reading what they already found
    if (!query) return;

    container.innerHTML = '<p class="empty-msg status-loading">Searching...</p>';

    try {
        const data    = await callAPI({ action: "search", query });
        const results = data.results || [];

        if (results.length === 0 || typeof results === "string") {
            container.innerHTML = '<p class="empty-msg">No relevant bookmarks found</p>';
            lastQuery   = query;
            lastResults = [];
            return;
        }

        // Cache results so they can be restored if user switches tabs
        lastQuery   = query;
        lastResults = results;
        chrome.storage.local.set({
            mindmark_last_query:   query,
            mindmark_last_results: results,
        });

        container.innerHTML = results.map(buildResultCard).join("");
        document.getElementById("searchClearWrap").style.display = "block";

    } catch (err) {
        container.innerHTML = '<p class="empty-msg">Search failed</p>';
    }
}

// ── Init ──────────────────────────────────────────────────────
// Runs once when the popup HTML is fully loaded
document.addEventListener("DOMContentLoaded", () => {
    initTabs();
    loadCurrentTab();

    // Restore last search from storage in case popup was closed
    // after clicking a result link
    chrome.storage.local.get(
        ["mindmark_last_query", "mindmark_last_results"],
        (stored) => {
            if (stored.mindmark_last_query && stored.mindmark_last_results?.length > 0) {
                lastQuery   = stored.mindmark_last_query;
                lastResults = stored.mindmark_last_results;
                document.getElementById("searchInput").value = lastQuery;
                document.getElementById("searchResults").innerHTML =
                    lastResults.map(buildResultCard).join("");
                document.getElementById("searchClearWrap").style.display = "block";
            }
        }
    );

    document.getElementById("clearSearchBtn").addEventListener("click", () => {
        lastQuery   = "";
        lastResults = [];
        chrome.storage.local.remove(["mindmark_last_query", "mindmark_last_results"]);
        document.getElementById("searchInput").value        = "";
        document.getElementById("searchResults").innerHTML  = "";
        document.getElementById("searchClearWrap").style.display = "none";
    });

    document.getElementById("saveBtn").addEventListener("click", saveBookmark);
    document.getElementById("refreshBtn").addEventListener("click", loadBookmarks);
    document.getElementById("searchBtn").addEventListener("click", searchBookmarks);

    // Allow Enter key in search box to trigger search
    document.getElementById("searchInput").addEventListener("keydown", (e) => {
        if (e.key === "Enter") searchBookmarks();
    });

    // Auth screen is hidden until Phase 6 wires it up
    document.getElementById("authScreen").style.display = "none";
    document.getElementById("mainUI").style.display     = "block";
});