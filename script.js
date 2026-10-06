/* ==========================================================================
   LUMA — a custom interface for publicly available YouTube videos.
   Vanilla JavaScript · no frameworks · no backend · localStorage only.

   Sections
   1.  Configuration
   2.  Storage helpers
   3.  Utilities (formatting, DOM, debounce)
   4.  Toasts
   5.  Theme (dark / light)
   6.  Onboarding (first launch username)
   7.  API setup screen
   8.  YouTube Data API layer
   9.  Shared render helpers (states, skeletons, cards)
   10. Local data: history, saved, reactions, stats
   11. Shell + router
   12. Home feed
   13. Search
   14. Watch page
   15. Shorts
   16. Library
   17. Profile
   18. Comments sheet
   19. Boot
   ========================================================================== */

/* ============================================================
   1. CONFIGURATION  —  paste your YouTube Data API v3 key here
   ============================================================ */
const YOUTUBE_API_KEY = "YOUR_API_KEY_HERE";

const API_BASE = "https://www.googleapis.com/youtube/v3";
const API_TIMEOUT = 12000;
const FEED_CACHE_MS = 5 * 60 * 1000;
const SHORTS_CACHE_MS = 10 * 60 * 1000;

/* localStorage keys */
const LS = {
  USER: "luma.username",
  CREATED: "luma.created",
  THEME: "luma.theme",
  KEY: "luma.apiKey",
  HISTORY: "luma.history",
  SAVED: "luma.saved",
  SEARCHES: "luma.searches",
  STATS: "luma.stats",
  REACTIONS: "luma.reactions",
  FILE_BANNER: "luma.fileBanner"
};

/* YouTube refuses embeds from file:// pages (Error 153: no referrer) — we detect
   that and swap players for a friendly "serve over HTTP" helper instead. */
const IS_FILE = location.protocol === "file:";
const LOCAL_SERVE_CMDS = [
  { cmd: "python -m http.server 8000" },
  { cmd: "npx --yes serve . -l 8000" }
];

/* Home category chips — "trending" uses the official charts endpoint,
   every other chip runs a regular public search. */
const HOME_CHIPS = [
  { key: "trending", label: "Trending", icon: "#i-flame" },
  { key: "gaming", label: "Gaming", icon: "#i-gamepad", q: "gaming" },
  { key: "music", label: "Music", icon: "#i-music", q: "music" },
  { key: "football", label: "Football", icon: "#i-ball", q: "football highlights" },
  { key: "punjabi", label: "Punjabi", icon: "#i-music", q: "punjabi songs" },
  { key: "tech", label: "Tech", icon: "#i-sparkles", q: "technology review" },
  { key: "news", label: "News", icon: "#i-news", q: "world news today" },
  { key: "bgmi", label: "BGMI", icon: "#i-gamepad", q: "bgmi tips" },
  { key: "podcasts", label: "Podcasts", icon: "#i-comment", q: "podcast episode" }
];

/* Curated seed queries used for search suggestions (no extra API calls) */
const SUGGEST_SEEDS = [
  "gaming", "bgmi tips", "bgmi gameplay", "punjabi songs", "punjabi new song 2026",
  "football highlights", "cricket highlights", "music mix", "lofi beats",
  "tech review", "coding tutorial", "javascript for beginners", "funny clips",
  "cooking recipe", "workout routine", "travel vlog", "podcast", "science explained"
];

/* Friendly copy for every failure mode — the UI never shows a raw error. */
const ERROR_COPY = {
  "no-key": {
    title: "YouTube isn’t connected yet",
    text: "Add a free YouTube Data API key so Luma can load public videos.",
    action: "Open setup", act: "open-setup", icon: "#i-key"
  },
  auth: {
    title: "That API key didn’t work",
    text: "Google rejected the key. Make sure it’s active and the YouTube Data API v3 is enabled for your project.",
    action: "Update API key", act: "open-setup", icon: "#i-alert"
  },
  quota: {
    title: "Daily quota exceeded",
    text: "Your key is valid but today’s YouTube API quota is used up. Quota resets at midnight Pacific time.",
    action: "Try again", act: "retry", icon: "#i-clock"
  },
  network: {
    title: "Connection problem",
    text: "We couldn’t reach YouTube. Check your internet connection and try again.",
    action: "Retry", act: "retry", icon: "#i-alert"
  },
  badRequest: {
    title: "YouTube rejected the request",
    text: "The request was invalid — usually a key or parameter problem.",
    action: "Retry", act: "retry", icon: "#i-alert"
  },
  forbidden: {
    title: "Access denied by YouTube",
    text: "This key isn’t allowed to make that request. Check that YouTube Data API v3 is enabled.",
    action: "Update API key", act: "open-setup", icon: "#i-key"
  },
  notFound: {
    title: "Not found on YouTube",
    text: "YouTube has no public record of that item — it may have been removed.",
    action: "Go Home", act: "go-home", icon: "#i-inbox"
  },
  unknown: {
    title: "Something went wrong",
    text: "YouTube returned an unexpected response. Please try again.",
    action: "Retry", act: "retry", icon: "#i-alert"
  }
};

/* ============================================================
   2. STORAGE HELPERS
   ============================================================ */
const Store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
  },
  del(key) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }
};

/** The configured key: the const above wins, otherwise a key saved from the setup screen. */
function getApiKey() {
  const hardcoded = String(YOUTUBE_API_KEY || "").trim();
  if (hardcoded && !hardcoded.includes("YOUR_API_KEY")) return hardcoded;
  return String(Store.get(LS.KEY, "") || "").trim();
}

/* ============================================================
   3. UTILITIES
   ============================================================ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Escape untrusted API strings before they touch innerHTML. */
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function debounce(fn, wait = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

/** ISO-8601 duration (PT4M13S) → seconds. */
function parseISODuration(iso) {
  if (!iso) return null;
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso);
  if (!m) return null;
  const [, d, h, mi, s] = m.map(Number);
  return (d || 0) * 86400 + (h || 0) * 3600 + (mi || 0) * 60 + (s || 0);
}

/** Seconds → "4:13" / "1:02:03". */
function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined || isNaN(seconds)) return "";
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** 1234567 → "1.2M". */
function compact(n) {
  if (n === null || n === undefined || isNaN(n)) return "";
  const num = Number(n);
  if (num >= 1e9) return trim(num / 1e9) + "B";
  if (num >= 1e6) return trim(num / 1e6) + "M";
  if (num >= 1e3) return trim(num / 1e3) + "K";
  return String(num);
  function trim(v) { return v.toFixed(1).replace(/\.0$/, ""); }
}

const fmtViews = (n) => (n === null || n === undefined ? "" : `${compact(n)} views`);

/** ISO date → "3 days ago" / "12 Mar 2025". */
function timeAgo(iso) {
  const then = new Date(iso);
  if (isNaN(then)) return "";
  const diff = (Date.now() - then.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} days ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / (86400 * 7))} wk ago`;
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))} mo ago`;
  const years = Math.floor(diff / (86400 * 365));
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

/** Relative time from a numeric timestamp (library entries). */
function timeAgoTs(ts) { return timeAgo(new Date(ts).toISOString()); }

/** First letters of a display name. */
function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Deterministic hue so a name always gets the same avatar colour. */
function hueFor(text) {
  let h = 0;
  for (const ch of String(text || "")) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/** Home region guess from the browser locale (used for trending). */
function guessRegion() {
  try {
    const loc = new Intl.Locale(navigator.language);
    if (loc.region) return loc.region.toUpperCase();
  } catch { /* unsupported */ }
  return undefined;
}

function icon(id, cls = "ico") {
  return `<svg class="${cls}" aria-hidden="true"><use href="${id}"></use></svg>`;
}

/* ============================================================
   4. TOASTS
   ============================================================ */
function toast(message, kind = "info") {
  const host = $("#toasts");
  if (!host) return;
  const el = document.createElement("div");
  el.className = `toast toast--${kind}`;
  const ic = kind === "ok" ? "#i-check" : kind === "err" ? "#i-alert" : "#i-sparkles";
  el.innerHTML = `${icon(ic)}<span>${esc(message)}</span>`;
  host.appendChild(el);
  setTimeout(() => {
    el.classList.add("is-leaving");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }, 2600);
}

/* ============================================================
   5. THEME
   ============================================================ */
function setTheme(theme) {
  const next = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  Store.set(LS.THEME, next);
  syncThemeControls(next);
}

function toggleTheme() {
  setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
}

function syncThemeControls(theme) {
  $$("[data-theme-value]").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.themeValue === theme);
  });
}

/* ============================================================
   6. ONBOARDING (first launch)
   ============================================================ */
function showOnboarding() {
  const ob = $("#onboarding");
  ob.hidden = false;
  requestAnimationFrame(() => ob.classList.add("is-visible"));
  setTimeout(() => $("#onboard-name")?.focus(), 350);
}

function bindOnboarding() {
  const form = $("#onboard-form");
  const input = $("#onboard-name");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = input.value.trim().replace(/\s+/g, " ");
    if (!name) {
      input.focus();
      input.classList.remove("is-pop");
      void input.offsetWidth;           // restart the shake/pop animation
      input.classList.add("is-pop");
      toast("Please enter a name first", "err");
      return;
    }
    Store.set(LS.USER, name);
    if (!Store.get(LS.CREATED)) Store.set(LS.CREATED, Date.now());

    const ob = $("#onboarding");
    ob.classList.add("is-leaving");
    setTimeout(() => {
      ob.hidden = true;
      ob.classList.remove("is-visible", "is-leaving");
      enterApp();
    }, 420);
  });
}

/* ============================================================
   7. API SETUP SCREEN
   ============================================================ */
let setupVisible = false;

function showSetup(note) {
  setupVisible = true;
  const el = $("#setup");
  el.hidden = false;
  $("#setup-note").textContent = note || "Free tier: 10,000 units/day — plenty for personal use.";
  setTimeout(() => $("#setup-key")?.focus(), 250);
}

function hideSetup() {
  setupVisible = false;
  $("#setup").hidden = true;
}

function bindSetup() {
  const form = $("#setup-form");
  const input = $("#setup-key");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = input.value.trim();
    if (!key) { toast("Paste an API key first", "err"); return; }
    if (!/^AIza[\w-]{10,}$/.test(key)) {
      $("#setup-note").textContent = "That doesn’t look like a Google API key (they start with “AIza”).";
      $("#setup-note").style.color = "var(--danger)";
      return;
    }
    Store.set(LS.KEY, key);
    const btn = form.querySelector("button[type=submit]");
    const label = btn.innerHTML;
    btn.innerHTML = "Checking…";
    btn.disabled = true;
    const err = await verifyApiKey();
    btn.innerHTML = label;
    btn.disabled = false;

    if (err && err.type === "auth") {
      $("#setup-note").textContent = "Google rejected that key — double-check it and try again.";
      $("#setup-note").style.color = "var(--danger)";
      Store.del(LS.KEY);
      return;
    }
    $("#setup-note").style.color = "";
    hideSetup();
    if (err && err.type === "quota") toast("Key saved, but today’s quota is used up", "err");
    else if (err && err.type === "network") toast("Saved — couldn’t verify while offline", "info");
    else toast("API key connected", "ok");
    route();
  });

  $("#setup-skip").addEventListener("click", () => {
    hideSetup();
    toast("Browsing the UI — connect a key anytime", "info");
    route();
  });

  $("#setup-retry").addEventListener("click", async () => {
    if (!getApiKey()) { toast("No key saved yet", "err"); return; }
    const err = await verifyApiKey();
    if (!err) { hideSetup(); toast("Key is working", "ok"); route(); }
    else if (err.type === "network") toast("Still unreachable — check your connection", "err");
    else if (err.type === "quota") { hideSetup(); toast("Key valid, but quota is exhausted", "err"); route(); }
    else toast(err.message || "Key rejected", "err");
  });

  $("#setup-copy").addEventListener("click", async () => {
    const line = 'const YOUTUBE_API_KEY = "YOUR_API_KEY_HERE";';
    try { await navigator.clipboard.writeText(line); toast("Copied — paste it in script.js", "ok"); }
    catch { toast("Copy failed — select the line manually", "err"); }
  });
}

/* ============================================================
   8. YOUTUBE DATA API LAYER
   ============================================================ */
class ApiError extends Error {
  constructor(type, message) {
    super(message);
    this.name = "ApiError";
    this.type = type;
  }
}

function errorFromResponse(res, data) {
  const err = data && data.error;
  const reason = err && err.errors && err.errors[0] && err.errors[0].reason;
  const message = (err && err.message) || `HTTP ${res.status}`;
  if (reason === "keyInvalid" || reason === "apiKeyExpired" || res.status === 400 && /api key/i.test(message)) {
    return new ApiError("auth", message);
  }
  if (reason === "quotaExceeded" || reason === "dailyLimitExceeded" || /quota/i.test(message)) {
    return new ApiError("quota", message);
  }
  if (res.status === 403) return new ApiError("forbidden", message);
  if (res.status === 400) return new ApiError("badRequest", message);
  if (res.status === 404) return new ApiError("notFound", message);
  return new ApiError("unknown", message);
}

/** Single entry point for every YouTube Data API request. */
async function ytFetch(resource, params = {}) {
  const key = getApiKey();
  if (!key) throw new ApiError("no-key", "No API key configured.");

  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  });
  qs.set("key", key);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT);
  let res;
  try {
    res = await fetch(`${API_BASE}/${resource}?${qs}`, { signal: ctrl.signal });
  } catch (e) {
    throw new ApiError("network", e && e.name === "AbortError" ? "Request timed out." : "Network request failed.");
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) throw errorFromResponse(res, data);
  return data;
}

/** Cheap call used by the setup screen to confirm a key works. */
async function verifyApiKey() {
  try {
    await ytFetch("search", { part: "snippet", q: "music", type: "video", maxResults: 1 });
    return null;
  } catch (e) {
    if (e instanceof ApiError && ["network", "quota"].includes(e.type)) return e;
    if (e instanceof ApiError) return e;
    return new ApiError("unknown", String(e));
  }
}

/** videos.list → normalised video objects. */
async function fetchVideoDetails(ids) {
  const clean = [...new Set(ids.filter(Boolean))].slice(0, 50);
  if (!clean.length) return [];
  const data = await ytFetch("videos", {
    part: "snippet,statistics,contentDetails",
    id: clean.join(",")
  });
  return (data.items || []).map(normalizeVideo);
}

/** channels.list → { channelId: avatarUrl } (used for feed avatars). */
async function fetchChannelAvatars(ids) {
  const clean = [...new Set(ids.filter(Boolean))].slice(0, 50);
  const map = new Map();
  if (!clean.length) return map;
  try {
    const data = await ytFetch("channels", { part: "snippet", id: clean.join(",") });
    (data.items || []).forEach((ch) => {
      const t = ch.snippet && ch.snippet.thumbnails;
      const url = (t && (t.medium || t.default || t.high) || {}).url;
      if (url) map.set(ch.id, url);
    });
  } catch { /* avatars are optional decoration */ }
  return map;
}

/** Raw videos.list item → the shape the UI renders. */
function normalizeVideo(item) {
  const s = item.snippet || {};
  const st = item.statistics || {};
  const cd = item.contentDetails || {};
  const thumbs = s.thumbnails || {};
  const thumb = (thumbs.medium || thumbs.high || thumbs.default || {}).url || "";
  return {
    id: typeof item.id === "string" ? item.id : item.id && item.id.videoId,
    title: s.title || "Untitled",
    channelId: s.channelId || "",
    channelTitle: s.channelTitle || "Unknown channel",
    description: s.description || "",
    thumb,
    publishedAt: s.publishedAt || "",
    live: s.liveBroadcastContent === "live",
    duration: parseISODuration(cd.duration),
    views: st.viewCount !== undefined ? Number(st.viewCount) : null,
    likes: st.likeCount !== undefined ? Number(st.likeCount) : null,
    commentCount: st.commentCount !== undefined ? Number(st.commentCount) : null
  };
}

/** search.list + videos.list enrichment (search snippets lack stats/duration). */
async function searchVideos(query, opts = {}) {
  const { max = 20, order, channelId, relatedToVideoId } = opts;
  const params = {
    part: "snippet",
    type: "video",
    maxResults: clamp(max, 1, 50),
    safeSearch: "moderate",
    videoEmbeddable: "true",
    q: query,
    channelId,
    relatedToVideoId,
    order
  };
  if (!params.q) delete params.q;
  const data = await ytFetch("search", params);
  const ids = (data.items || []).map((it) => it.id && it.id.videoId).filter(Boolean);
  if (!ids.length) return [];
  const details = await fetchVideoDetails(ids);
  const byId = new Map(details.map((v) => [v.id, v]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

/** Official charts endpoint — used by the "Trending" chip. */
async function fetchTrending(max = 24) {
  const params = { part: "snippet,statistics,contentDetails", chart: "mostPopular", maxResults: clamp(max, 1, 50) };
  const region = guessRegion();
  if (region) params.regionCode = region;
  const data = await ytFetch("videos", params);
  return (data.items || []).map(normalizeVideo);
}

/** commentThreads.list → [] when comments are disabled or unavailable. */
async function fetchComments(videoId, max = 20) {
  try {
    const data = await ytFetch("commentThreads", {
      part: "snippet",
      videoId,
      maxResults: clamp(max, 1, 100),
      order: "relevance",
      textFormat: "plainText"
    });
    return (data.items || []).map((it) => {
      const top = it.snippet && it.snippet.topLevelComment && it.snippet.topLevelComment.snippet || {};
      return {
        id: it.id,
        author: top.authorDisplayName || "Anonymous",
        authorChannel: top.authorChannelId && top.authorChannelId.value || "",
        text: top.textDisplay || top.textPublished || "",
        publishedAt: top.publishedAt || "",
        likes: Number(top.likeCount) || 0,
        avatar: (top.authorProfileImageUrl || "").replace(/=s\d+/, "=s64")
      };
    });
  } catch (e) {
    if (e instanceof ApiError && ["network", "quota", "auth", "no-key"].includes(e.type)) throw e;
    return [];   // comments disabled / forbidden → treated as "no comments"
  }
}

/** Related videos: official relatedToVideoId with a title-keyword fallback. */
async function fetchRelated(video, max = 14) {
  try {
    const list = await searchVideos("", { relatedToVideoId: video.id, max });
    const usable = list.filter((v) => v.id !== video.id);
    if (usable.length) return usable;
  } catch { /* endpoint deprecated / unavailable → fall through */ }
  const words = String(video.title || "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 6)
    .join(" ");
  try {
    const list = await searchVideos(words || video.channelTitle, { max });
    return list.filter((v) => v.id !== video.id);
  } catch { return []; }
}

/* ============================================================
   9. SHARED RENDER HELPERS
   ============================================================ */

/** Full-page error state with retry / setup actions. */
function errorState(type, extra = {}) {
  const copy = ERROR_COPY[type] || ERROR_COPY.unknown;
  const act = extra.act || copy.act;
  const actionLabel = extra.action || copy.action;
  const code = extra.code
    ? `<p class="state__code" title="${esc(extra.code)}">${esc(extra.code)}</p>` : "";
  return `
    <div class="state">
      <div class="state__icon ${type === "auth" || type === "no-key" ? "state__icon--accent" : type === "unknown" ? "" : "state__icon--danger"}">
        ${icon(copy.icon, "ico")}
      </div>
      <h2 class="state__title">${esc(copy.title)}</h2>
      <p class="state__text">${esc(copy.text)}</p>
      ${code}
      <div class="state__actions">
        <button class="btn btn--primary" data-action="${esc(act)}">${esc(actionLabel)}</button>
      </div>
    </div>`;
}

function emptyState({ iconId = "#i-inbox", title, text, actions = "" }) {
  return `
    <div class="state">
      <div class="state__icon state__icon--accent">${icon(iconId, "ico")}</div>
      <h2 class="state__title">${esc(title)}</h2>
      <p class="state__text">${esc(text)}</p>
      ${actions ? `<div class="state__actions">${actions}</div>` : ""}
    </div>`;
}

function skeletonGrid(count = 8) {
  const card = `
    <div class="skel-card">
      <div class="skel skel-thumb"></div>
      <div class="row" style="gap:11px;align-items:flex-start">
        <div class="skel skel-avatar"></div>
        <div style="flex:1;display:flex;flex-direction:column;gap:9px">
          <div class="skel skel-line"></div>
          <div class="skel skel-line skel-line--mid"></div>
          <div class="skel skel-line skel-line--short"></div>
        </div>
      </div>
    </div>`;
  return `<div class="feed-grid">${card.repeat(count)}</div>`;
}

function skeletonRows(count = 5) {
  const row = `
    <div class="skel-row">
      <div class="skel skel-thumb"></div>
      <div class="skel-lines">
        <div class="skel skel-line"></div>
        <div class="skel skel-line skel-line--mid"></div>
        <div class="skel skel-line skel-line--short"></div>
      </div>
    </div>`;
  return `<div>${row.repeat(count)}</div>`;
}

function loadingCenter(label = "Loading videos…") {
  return `<div class="loading-center"><div class="spinner"></div><span>${esc(label)}</span></div>`;
}

/** Thumbnail <img> with graceful fallback when YouTube has no image. */
function thumbImg(video, eager = false) {
  if (!video.thumb) {
    return `<div class="thumb-fallback">${icon("#i-play")}</div>`;
  }
  return `<img src="${esc(video.thumb)}" alt="" ${eager ? "" : 'loading="lazy"'} decoding="async"
    onerror="this.parentElement.innerHTML='&lt;div class=\\'thumb-fallback\\'&gt;&lt;svg class=\\'ico\\\'&gt;&lt;use href=\\\'#i-play\\\'&gt;&lt;/use&gt;&lt;/svg&gt;&lt;/div&gt;'">`;
}

function avatarHTML(name, url, cls = "") {
  const h = hueFor(name);
  if (url) {
    return `<span class="avatar ${cls}" style="--av-h:${h}"><img src="${esc(url)}" alt="" loading="lazy"
      onerror="this.parentElement.textContent='${esc(initials(name))}'"></span>`;
  }
  return `<span class="avatar ${cls}" style="--av-h:${h}" aria-hidden="true">${esc(initials(name))}</span>`;
}

/** Standard feed card. */
function videoCardHTML(video, opts = {}) {
  remember(video);
  const saved = isSaved(video.id);
  const dur = video.live ? "LIVE" : fmtDuration(video.duration);
  const stats = [
    video.views !== null ? fmtViews(video.views) : "",
    video.publishedAt ? timeAgo(video.publishedAt) : ""
  ].filter(Boolean).map((s) => `<span>${esc(s)}</span>`).join("");

  return `
    <article class="card ${opts.hero ? "card--hero" : ""}" data-watch="${esc(video.id)}" tabindex="0" role="link"
             aria-label="Play ${esc(video.title)}">
      <div class="card__thumb">
        ${thumbImg(video, opts.hero)}
        ${video.live ? `<span class="card__live">Live</span>` : dur ? `<span class="card__dur">${esc(dur)}</span>` : ""}
        <div class="card__hover-acts">
          <button class="icon-btn ${saved ? "is-on" : ""}" data-action="save" data-id="${esc(video.id)}"
                  aria-label="Save video" title="Save">
            ${icon("#i-bookmark", "ico ico--16")}
          </button>
        </div>
      </div>
      <div class="card__body">
        ${avatarHTML(video.channelTitle, video.avatar || "", "avatar--sm")}
        <div class="card__meta">
          <h3 class="card__title">${esc(video.title)}</h3>
          <p class="card__channel">${esc(video.channelTitle)}</p>
          <p class="card__stats">${stats}</p>
        </div>
      </div>
    </article>`;
}

/** Horizontal search-result row. */
function searchResultHTML(video) {
  remember(video);
  const stats = [
    video.views !== null ? fmtViews(video.views) : "",
    video.publishedAt ? timeAgo(video.publishedAt) : "",
    video.duration ? fmtDuration(video.duration) : ""
  ].filter(Boolean).join(" · ");

  return `
    <article class="result" data-watch="${esc(video.id)}" tabindex="0" role="link" aria-label="Play ${esc(video.title)}">
      <div class="result__thumb">
        ${thumbImg(video)}
        ${video.duration ? `<span class="card__dur">${esc(fmtDuration(video.duration))}</span>` : ""}
      </div>
      <div class="card__meta">
        <h3 class="result__title">${esc(video.title)}</h3>
        <div class="result__channel">
          ${avatarHTML(video.channelTitle, "", "avatar--sm")}
          <span>${esc(video.channelTitle)}</span>
        </div>
        <p class="result__stats">${esc(stats)}</p>
        <p class="result__desc">${esc(String(video.description || "").slice(0, 180))}</p>
      </div>
    </article>`;
}

/** Compact row for related videos / library / history. */
function miniVideoHTML(video, opts = {}) {
  remember(video);
  const meta = opts.meta !== undefined ? opts.meta : [
    video.channelTitle,
    video.views !== null ? fmtViews(video.views) : "",
    video.publishedAt ? timeAgo(video.publishedAt) : ""
  ].filter(Boolean).join(" · ");

  return `
    <div class="related-item" data-watch="${esc(video.id)}" tabindex="0" role="link" aria-label="Play ${esc(video.title)}">
      <div class="related-item__thumb">
        ${thumbImg(video)}
        ${video.duration ? `<span class="card__dur">${esc(fmtDuration(video.duration))}</span>` : ""}
      </div>
      <div class="card__meta">
        <h4 class="related-item__title">${esc(video.title)}</h4>
        <p class="related-item__meta">${esc(meta)}</p>
      </div>
    </div>`;
}

/* ============================================================
   10. LOCAL DATA — history, saved, reactions, stats, memory
   ============================================================ */

/** Session memory of every video we've rendered (used by save/share/like). */
const knownVideos = new Map();
function remember(video) {
  if (video && video.id) knownVideos.set(video.id, video);
}
function known(id) { return knownVideos.get(id) || null; }

const getHistory = () => Store.get(LS.HISTORY, []) || [];
const getSaved = () => Store.get(LS.SAVED, []) || [];
const isSaved = (id) => getSaved().some((v) => v.id === id);

const getReactions = () => Store.get(LS.REACTIONS, { like: [], dislike: [] }) || { like: [], dislike: [] };
const hasLiked = (id) => getReactions().like.includes(id);

function toggleSave(id) {
  const list = getSaved();
  const at = list.findIndex((v) => v.id === id);
  if (at >= 0) {
    list.splice(at, 1);
    Store.set(LS.SAVED, list);
    refreshSaveButtons(id);
    toast("Removed from your library", "ok");
    return false;
  }
  const video = known(id);
  if (!video) return false;
  list.unshift({ ...video, savedAt: Date.now() });
  Store.set(LS.SAVED, list.slice(0, 200));
  refreshSaveButtons(id);
  toast("Saved to your library", "ok");
  return true;
}

/** Update every save control for a video without a full re-render. */
function refreshSaveButtons(id) {
  const on = isSaved(id);
  $$(`[data-action="save"][data-id="${CSS.escape(id)}"], [data-action="save-watch"][data-id="${CSS.escape(id)}"]`)
    .forEach((btn) => {
      btn.classList.toggle("is-on", on);
      const label = btn.querySelector("[data-save-label]");
      if (label) label.textContent = on ? "Saved" : "Save";
      btn.classList.remove("is-pop");
      void btn.offsetWidth;
      btn.classList.add("is-pop");
    });
}

function toggleLike(id, dislike = false) {
  const r = getReactions();
  const key = dislike ? "dislike" : "like";
  const other = dislike ? "like" : "dislike";
  r[other] = (r[other] || []).filter((x) => x !== id);
  if ((r[key] || []).includes(id)) r[key] = r[key].filter((x) => x !== id);
  else r[key] = [...(r[key] || []), id];
  Store.set(LS.REACTIONS, r);
  return (r[key] || []).includes(id);
}

function addHistory(video) {
  if (!video || !video.id) return;
  const list = getHistory().filter((v) => v.id !== video.id);
  list.unshift({ ...video, watchedAt: Date.now() });
  Store.set(LS.HISTORY, list.slice(0, 80));
  bumpStat("watched");
}

function removeFromHistory(id) {
  Store.set(LS.HISTORY, getHistory().filter((v) => v.id !== id));
}

const getStats = () => Object.assign(
  { watched: 0, saved: 0, searches: 0, shorts: 0 },
  Store.get(LS.STATS, {}) || {}
);

function bumpStat(key, by = 1) {
  const s = getStats();
  s[key] = (s[key] || 0) + by;
  Store.set(LS.STATS, s);
}

const getRecentSearches = () => Store.get(LS.SEARCHES, []) || [];

function pushRecentSearch(term) {
  const t = String(term || "").trim();
  if (!t) return;
  const list = getRecentSearches().filter((x) => x.toLowerCase() !== t.toLowerCase());
  list.unshift(t);
  Store.set(LS.SEARCHES, list.slice(0, 8));
}

/* ============================================================
   11. SHELL + ROUTER
   ============================================================ */
let renderSeq = 0;          // guards against out-of-order async renders
let currentRoute = { name: "home", param: null, query: new URLSearchParams() };

const view = () => $("#view");

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, query = ""] = raw.split("?");
  const parts = path.split("/").filter(Boolean);
  return {
    name: parts[0] || "home",
    param: parts[1] ? decodeURIComponent(parts[1]) : null,
    query: new URLSearchParams(query)
  };
}

function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function goSearch(term) {
  const q = String(term || "").trim();
  if (q) pushRecentSearch(q);
  navigate(q ? `#/search?q=${encodeURIComponent(q)}` : "#/search");
}

function setNavActive(name) {
  const key = name === "watch" ? "home" : name;
  $$("[data-nav]").forEach((el) => {
    if (el.dataset.nav === key) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  });
}

/** Central router — every view renders through here. */
async function route() {
  const next = parseRoute();
  currentRoute = next;
  const seq = ++renderSeq;
  setNavActive(next.name);

  // Shorts owns the full viewport (its own scroller).
  const el = view();
  el.classList.toggle("view--flush", next.name === "shorts");
  el.classList.toggle("view--scroll", next.name !== "shorts");

  try {
    switch (next.name) {
      case "home": await renderHome(seq); break;
      case "search": await renderSearch(seq, next.query.get("q") || ""); break;
      case "watch": await renderWatch(seq, next.param); break;
      case "shorts": await renderShorts(seq); break;
      case "library": renderLibrary(seq); break;
      case "profile": renderProfile(seq); break;
      case "setup": showSetup(); break;
      default: navigate("#/home");
    }
  } catch (e) {
    if (seq !== renderSeq) return;
    console.error("Render failed:", e);
    el.innerHTML = errorState("unknown");
  }

  if (seq === renderSeq && next.name !== "shorts") el.scrollTop = 0;
}

function isStale(seq) { return seq !== renderSeq; }

/* ---- global shell bindings ---- */
function bindShell() {
  // Mobile/desktop search field in the top bar
  $("#topbar-form").addEventListener("submit", (e) => {
    e.preventDefault();
    goSearch($("#topbar-input").value);
  });

  $("#theme-btn").addEventListener("click", toggleTheme);
  $("#theme-row").addEventListener("click", toggleTheme);
  $("#avatar-btn").addEventListener("click", () => navigate("#/profile"));

  // Single delegated click handler for every view
  view().addEventListener("click", handleViewClick);
  view().addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const target = e.target.closest("[data-watch]");
    if (target) { e.preventDefault(); navigate(`#/watch/${target.dataset.watch}`); }
  });

  window.addEventListener("hashchange", route);

  window.addEventListener("error", (e) => {
    if (e.target && e.target.tagName === "IMG") return;   // handled by thumb fallbacks
    console.error("Uncaught:", e.error || e.message);
  });
}

/** Delegated clicks: action controls win, cards navigate to the watch page. */
function handleViewClick(e) {
  const actionEl = e.target.closest("[data-action]");
  const watchEl = e.target.closest("[data-watch]");

  // Clicked a control (save/like/chip/tab…) — run it and never navigate.
  if (actionEl && (!watchEl || watchEl.contains(actionEl))) {
    e.preventDefault();
    runAction(actionEl, e);
    return;
  }
  // Otherwise a card/row click opens the video.
  if (watchEl) {
    navigate(`#/watch/${watchEl.dataset.watch}`);
  }
}

function runAction(el, e) {
  const action = el.dataset.action;
  const id = el.dataset.id;

  switch (action) {
    case "save":
    case "save-watch":
      toggleSave(id);
      if (["library", "profile"].includes(currentRoute.name)) route();
      break;

    case "like":
    case "dislike": {
      const on = toggleLike(id, action === "dislike");
      updateReactionUI(id);
      if (on) toast(action === "like" ? "Liked" : "Noted — feedback saved", "ok");
      break;
    }

    case "share":
      shareVideo(id);
      break;

    case "chip":
      selectChip(el.dataset.chipKey);
      break;

    case "tab":
      setLibraryTab(el.dataset.tab);
      break;

    case "retry":
      route();
      break;

    case "go-home":
      navigate("#/home");
      break;

    case "open-setup":
      showSetup();
      break;

    case "search-term":
      goSearch(el.dataset.term);
      break;

    case "clear-history":
      if (confirm("Clear your entire watch history from this device?")) {
        Store.set(LS.HISTORY, []);
        toast("Watch history cleared", "ok");
        route();
      }
      break;

    case "remove-history":
      removeFromHistory(id);
      route();
      break;

    case "remove-saved":
      toggleSave(id);
      route();
      break;

    case "clear-searches":
      Store.set(LS.SEARCHES, []);
      route();
      break;

    case "expand-desc": {
      const open = el.classList.toggle("is-open");
      el.setAttribute("aria-expanded", String(open));
      const more = el.querySelector("[data-desc-more]");
      if (more) more.textContent = open ? "Show less" : "Show more";
      break;
    }

    case "edit-name":
      startEditName();
      break;

    case "save-name":
      saveEditedName();
      break;

    case "cancel-name":
      route();
      break;

    case "set-theme":
      setTheme(el.dataset.themeValue);
      break;

    case "reset-data":
      if (confirm("This erases your name, theme, key, history and saved videos from this device. Continue?")) {
        Object.values(LS).forEach(Store.del);
        location.hash = "";
        location.reload();
      }
      break;

    case "shorts-up":
      stepShorts(-1);
      break;

    case "shorts-down":
      stepShorts(1);
      break;

    case "short-toggle":
      toggleShort(Number(el.dataset.index) || Shorts.index);
      break;

    case "short-comments":
      openSheet(id);
      break;

    case "short-follow":
      el.classList.toggle("is-on");
      el.textContent = el.classList.contains("is-on") ? "Following" : "Follow";
      toast(el.classList.contains("is-on")
        ? "Follows happen on YouTube itself"
        : "Unfollowed", "info");
      break;

    case "copy-cmd":
      copyCommand(el.dataset.cmd || "");
      break;

    case "dismiss-file-banner":
      Store.set(LS.FILE_BANNER, 1);
      document.getElementById("file-banner")?.remove();
      break;

    default:
      break;
  }
}

async function shareVideo(id) {
  const video = known(id);
  const url = `https://www.youtube.com/watch?v=${id}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: video ? video.title : "Watch on Luma", url });
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied to clipboard", "ok");
  } catch {
    const ta = document.createElement("textarea");
    ta.value = url;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); toast("Link copied to clipboard", "ok"); }
    catch { toast("Couldn’t copy the link", "err"); }
    ta.remove();
  }
}

function updateReactionUI(id) {
  const liked = hasLiked(id);
  const v = known(id);
  const likeBtn = $(`[data-action="like"][data-id="${CSS.escape(id)}"]`);
  const dislikeBtn = $(`[data-action="dislike"][data-id="${CSS.escape(id)}"]`);
  if (likeBtn) {
    likeBtn.classList.toggle("is-on", liked);
    const c = likeBtn.querySelector("[data-like-count]");
    if (c && v && v.likes !== null) c.textContent = compact(v.likes + (liked ? 1 : 0));
    likeBtn.classList.remove("is-pop"); void likeBtn.offsetWidth; likeBtn.classList.add("is-pop");
  }
  if (dislikeBtn) {
    const disliked = getReactions().dislike.includes(id);
    dislikeBtn.classList.toggle("is-on", disliked);
  }
}

/* ============================================================
   12. HOME FEED
   ============================================================ */
let activeChip = "trending";
const feedCache = new Map();

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function homeHeader() {
  const name = Store.get(LS.USER, "there");
  return `
    <div class="page-head">
      <div>
        <p class="eyebrow">${esc(greeting())}, ${esc(name)}</p>
        <h1 class="page-title">Home</h1>
        <p class="page-sub">Public YouTube videos, presented in a fresh layout.</p>
      </div>
    </div>
    <div class="chips" role="tablist" aria-label="Feed categories">
      ${HOME_CHIPS.map((c) => `
        <button class="chip ${c.key === activeChip ? "is-active" : ""}" role="tab"
                aria-selected="${c.key === activeChip}" data-action="chip" data-chip-key="${c.key}" type="button">
          ${c.icon ? icon(c.icon, "ico") : ""}${esc(c.label)}
        </button>`).join("")}
    </div>`;
}

function connectPrompt() {
  return emptyState({
    iconId: "#i-key",
    title: "YouTube isn’t connected",
    text: "Add a free YouTube Data API key and this screen fills with public videos in seconds.",
    actions: `<button class="btn btn--primary" data-action="open-setup">Open setup</button>`
  });
}

/** Loads (and caches) one category of the home feed. */
async function getHomeFeed(chip) {
  const hit = feedCache.get(chip.key);
  if (hit && Date.now() - hit.t < FEED_CACHE_MS) return hit.v;

  let videos;
  if (chip.key === "trending") videos = await fetchTrending(24);
  else videos = await searchVideos(chip.q, { max: 24 });

  const avatars = await fetchChannelAvatars(videos.map((v) => v.channelId));
  videos.forEach((v) => { v.avatar = avatars.get(v.channelId) || ""; remember(v); });

  feedCache.set(chip.key, { t: Date.now(), v: videos });
  return videos;
}

async function renderHome(seq) {
  const el = view();
  el.innerHTML = homeHeader();

  if (!getApiKey()) { el.innerHTML += connectPrompt(); return; }
  el.innerHTML += skeletonGrid(window.innerWidth < 600 ? 4 : 8);

  try {
    const videos = await getHomeFeed(HOME_CHIPS.find((c) => c.key === activeChip) || HOME_CHIPS[0]);
    if (isStale(seq)) return;

    if (!videos.length) {
      el.innerHTML = homeHeader() + emptyState({
        iconId: "#i-inbox",
        title: "Nothing to show here",
        text: "This category returned no videos. Try another chip above.",
        actions: `<button class="btn btn--primary" data-action="chip" data-chip-key="trending">Back to Trending</button>`
      });
      return;
    }

    const [first, ...rest] = videos;
    el.innerHTML = homeHeader() +
      `<div class="feed-grid">
        ${videoCardHTML(first, { hero: true })}
        ${rest.map((v) => videoCardHTML(v)).join("")}
      </div>`;
  } catch (e) {
    if (isStale(seq)) return;
    if (e && e.type === "no-key") el.innerHTML = homeHeader() + connectPrompt();
    else el.innerHTML = homeHeader() + errorState(e.type || "unknown", { code: e.message });
  }
}

function selectChip(key) {
  if (!HOME_CHIPS.some((c) => c.key === key)) return;
  activeChip = key;
  const seq = ++renderSeq;
  const el = view();
  $$(".chip", el).forEach((chip) => {
    const on = chip.dataset.chipKey === key;
    chip.classList.toggle("is-active", on);
    chip.setAttribute("aria-selected", String(on));
  });
  const grid = $(".feed-grid", el);
  if (grid) grid.outerHTML = skeletonGrid(window.innerWidth < 600 ? 4 : 8);

  getHomeFeed(HOME_CHIPS.find((c) => c.key === key))
    .then((videos) => {
      if (isStale(seq)) return;
      if (!videos.length) {
        route();
        return;
      }
      const [first, ...rest] = videos;
      const host = $(".feed-grid", el) || $(".state", el);
      const html = `<div class="feed-grid">${videoCardHTML(first, { hero: true })}${rest.map((v) => videoCardHTML(v)).join("")}</div>`;
      if (host) host.outerHTML = html;
      else el.innerHTML = homeHeader() + html;
      el.scrollTop = 0;
    })
    .catch((e) => {
      if (isStale(seq)) return;
      const host = $(".feed-grid", el) || $(".loading-center", el);
      const html = e && e.type === "no-key" ? connectPrompt() : errorState(e.type || "unknown", { code: e.message });
      if (host) host.outerHTML = html;
      else el.innerHTML = homeHeader() + html;
    });
}

/* ============================================================
   13. SEARCH
   ============================================================ */
function buildSuggestions(raw) {
  const term = String(raw || "").trim().toLowerCase();
  const pool = [...getRecentSearches(), ...SUGGEST_SEEDS];
  const seen = new Set();
  const starts = [];
  const contains = [];
  pool.forEach((s) => {
    const low = String(s).toLowerCase();
    if (seen.has(low)) return;
    seen.add(low);
    if (!term || low === term) return;
    if (low.startsWith(term)) starts.push(s);
    else if (low.includes(term)) contains.push(s);
  });
  return [...starts, ...contains].slice(0, 8);
}

function highlightMatch(text, term) {
  const safe = esc(text);
  const t = String(term || "").trim();
  if (!t) return safe;
  const idx = safe.toLowerCase().indexOf(esc(t).toLowerCase());
  if (idx < 0) return safe;
  return safe.slice(0, idx) + "<b>" + safe.slice(idx, idx + t.length) + "</b>" + safe.slice(idx + t.length);
}

function renderSuggestList(raw) {
  const host = $("#suggest-host");
  if (!host) return;
  const items = buildSuggestions(raw);
  if (!String(raw || "").trim() || !items.length) { host.innerHTML = ""; return; }
  host.innerHTML = `
    <div class="suggest" role="listbox">
      ${items.map((s, i) => `
        <button class="suggest__item" type="button" role="option" data-action="search-term" data-term="${esc(s)}" data-si="${i}">
          ${icon("#i-search")}
          <span>${highlightMatch(s, raw)}</span>
          ${getRecentSearches().some((r) => r === s) ? `<span class="suggest__tag">recent</span>` : ""}
        </button>`).join("")}
    </div>`;
}

function closeSuggest() {
  const host = $("#suggest-host");
  if (host) host.innerHTML = "";
}

function suggestionChipsHTML(limit = 6) {
  const terms = [...getRecentSearches(), ...SUGGEST_SEEDS].slice(0, limit);
  return terms.map((t) =>
    `<button class="chip" type="button" data-action="search-term" data-term="${esc(t)}">${esc(t)}</button>`
  ).join("");
}

async function renderSearch(seq, q) {
  const el = view();
  const recents = getRecentSearches();

  el.innerHTML = `
    <div class="page-head">
      <div>
        <p class="eyebrow">Discover</p>
        <h1 class="page-title">Search</h1>
        <p class="page-sub">Find any public video on YouTube through Luma.</p>
      </div>
    </div>

    <div class="search-wrap">
      <form class="search-bar" id="search-form" role="search">
        ${icon("#i-search")}
        <input id="search-input" type="search" autocomplete="off" spellcheck="false"
               placeholder="Try “BGMI tips”, “punjabi songs”, “gaming”…"
               value="${esc(q)}" aria-label="Search videos">
        <button class="btn btn--primary" type="submit">Search</button>
      </form>
      <div id="suggest-host"></div>
    </div>

    ${recents.length ? `
      <div class="row gap-8" style="flex-wrap:wrap;margin-top:16px;align-items:center">
        <span class="faint" style="font-size:13px;font-weight:700">Recent</span>
        ${recents.map((r) => `<button class="chip" type="button" data-action="search-term" data-term="${esc(r)}">${icon("#i-clock", "ico")}${esc(r)}</button>`).join("")}
        <button class="chip" type="button" data-action="clear-searches">Clear</button>
      </div>` : ""}

    <div id="search-results">
      ${q ? loadingCenter("Searching YouTube…") : `
        <div class="section-bar mt-24"><h2 class="section-title">Popular searches</h2></div>
        <div class="recent-row">${suggestionChipsHTML(8)}</div>
        ${emptyState({
          iconId: "#i-search",
          title: "What are you looking for?",
          text: "Type anything above — games, music, highlights, tutorials — and press Search.",
          actions: ""
        })}`}
    </div>`;

  bindSearchInputs();
  if (q) runSearch(seq, q);
}

function bindSearchInputs() {
  const form = $("#search-form");
  const input = $("#search-input");
  if (!form || !input) return;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    closeSuggest();
    goSearch(input.value);
  });

  const debouncedSuggest = debounce(() => renderSuggestList(input.value), 180);
  input.addEventListener("input", debouncedSuggest);

  input.addEventListener("keydown", (e) => {
    const host = $("#suggest-host");
    const options = $$(".suggest__item", host || document);
    if (!options.length) return;
    let idx = options.findIndex((o) => o.classList.contains("is-active"));

    if (e.key === "ArrowDown") {
      e.preventDefault();
      idx = (idx + 1) % options.length;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      idx = idx <= 0 ? options.length - 1 : idx - 1;
    } else if (e.key === "Enter" && idx >= 0) {
      e.preventDefault();
      closeSuggest();
      goSearch(options[idx].dataset.term);
      return;
    } else if (e.key === "Escape") {
      closeSuggest();
      return;
    } else {
      return;
    }
    options.forEach((o, i) => o.classList.toggle("is-active", i === idx));
    options[idx].scrollIntoView({ block: "nearest" });
  });
}

async function runSearch(seq, q) {
  const host = $("#search-results");
  if (!host) return;

  if (!getApiKey()) { host.innerHTML = connectPrompt(); return; }
  host.innerHTML = skeletonRows(6);

  try {
    const results = await searchVideos(q, { max: 20 });
    if (isStale(seq) || currentRoute.name !== "search") return;
    bumpStat("searches");

    if (!results.length) {
      host.innerHTML = emptyState({
        iconId: "#i-search",
        title: `No results for “${q}”`,
        text: "Try different keywords, check the spelling, or pick one of these:",
        actions: `<div class="recent-row" style="justify-content:center">${suggestionChipsHTML(6)}</div>`
      });
      return;
    }

    host.innerHTML = `
      <div class="results-head">
        <span class="results-count">${results.length} result${results.length === 1 ? "" : "s"} for “${esc(q)}”</span>
        <span class="results-count">via YouTube Data API</span>
      </div>
      <div class="result-list">${results.map(searchResultHTML).join("")}</div>`;
  } catch (e) {
    if (isStale(seq) || currentRoute.name !== "search") return;
    if (e && e.type === "no-key") host.innerHTML = connectPrompt();
    else host.innerHTML = errorState(e.type || "unknown", { code: e.message });
  }
}

/* ============================================================
   14. WATCH PAGE
   ============================================================ */
/** Official embed URL — nocookie host + origin param (when served over HTTP). */
function embedSrc(id, params) {
  const origin = /^https?:$/.test(location.protocol)
    ? `&origin=${encodeURIComponent(location.origin)}` : "";
  return `https://www.youtube-nocookie.com/embed/${id}?${params}${origin}`;
}

function playerIFrame(video) {
  return `<iframe src="${embedSrc(esc(video.id), "autoplay=1&rel=0&modestbranding=1&playsinline=1")}"
          title="${esc(video.title)}"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
}

/** Shown instead of the player on file:// — YouTube blocks those embeds (Error 153). */
function localFixHTML(video) {
  return `
    <div class="local-fix">
      <span class="local-fix__ico">${icon("#i-alert")}</span>
      <h3>Videos can’t play from a local file</h3>
      <p>YouTube returns <strong>Error 153</strong> when a page has no web address — and a <code>file://</code> page never sends one. No embed code can fix that.</p>
      <p><strong>Serve this folder over HTTP instead (run in this project’s folder):</strong></p>
      <div class="local-fix__cmds">
        ${LOCAL_SERVE_CMDS.map((c) => `
          <div class="cmd-row">
            <code>${esc(c.cmd)}</code>
            <button class="cmd-row__copy" type="button" data-action="copy-cmd" data-cmd="${esc(c.cmd)}">${icon("#i-copy", "ico ico--14")} Copy</button>
          </div>`).join("")}
      </div>
      <p class="local-fix__after">Then open <a href="http://localhost:8000">http://localhost:8000</a> — the player works there.</p>
      <a class="btn btn--soft btn--sm" href="https://www.youtube.com/watch?v=${esc(video.id)}" target="_blank" rel="noopener noreferrer">
        Watch on YouTube ${icon("#i-external", "ico ico--14")}
      </a>
    </div>`;
}

async function copyCommand(cmd) {
  if (!cmd) return;
  try {
    await navigator.clipboard.writeText(cmd);
    toast("Copied — paste it in your terminal", "ok");
  } catch {
    const ta = document.createElement("textarea");
    ta.value = cmd;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); toast("Copied — paste it in your terminal", "ok"); }
    catch { toast("Couldn’t copy — select the command manually", "err"); }
    ta.remove();
  }
}
function watchSkeleton() {
  return `
    <div class="watch">
      <div class="watch__main">
        <div class="player-frame">
          <div class="loading-center" style="height:100%"><div class="spinner"></div><span>Loading player…</span></div>
        </div>
        <div class="skel skel-line" style="height:24px;width:78%"></div>
        <div class="row"><div class="skel skel-avatar"></div><div class="skel skel-line skel-line--mid" style="flex:1"></div></div>
        <div class="skel skel-line"></div>
        <div class="skel skel-line skel-line--mid"></div>
        <div class="skel skel-line skel-line--short"></div>
      </div>
      <aside class="related">${skeletonRows(5)}</aside>
    </div>`;
}

function invalidVideoState() {
  return emptyState({
    iconId: "#i-alert",
    title: "This video isn’t available",
    text: "The link may be broken, the video private, or the ID invalid.",
    actions: `
      <button class="btn btn--primary" data-action="retry">Try again</button>
      <a class="btn btn--soft" href="#/home">Back to Home</a>`
  });
}

async function fetchChannelInfo(channelId) {
  if (!channelId) return null;
  const data = await ytFetch("channels", { part: "snippet,statistics", id: channelId });
  const ch = (data.items || [])[0];
  if (!ch) return null;
  const t = ch.snippet.thumbnails || {};
  return {
    title: ch.snippet.title,
    avatar: (t.medium || t.default || {}).url || "",
    subscribers: ch.statistics && ch.statistics.subscriberCount ? Number(ch.statistics.subscriberCount) : null,
    description: ch.snippet.description || ""
  };
}

function commentsSection(video, comments) {
  const count = video.commentCount;
  const head = `
    <div class="comments__head">
      <span class="comments__count">${count !== null ? compact(count) + " Comments" : "Comments"}</span>
    </div>`;

  if (comments === null) {
    return `<section class="comments">${head}<p class="empty-note">Comments couldn’t be loaded right now.</p></section>`;
  }
  if (!comments.length) {
    return `<section class="comments">${head}<p class="empty-note">No comments yet — be the first to say something on YouTube.</p></section>`;
  }
  return `<section class="comments">${head}${comments.map(commentHTML).join("")}</section>`;
}

function commentHTML(c) {
  return `
    <div class="comment">
      ${avatarHTML(c.author, c.avatar, "avatar--sm")}
      <div class="comment__body">
        <div class="comment__meta"><strong>${esc(c.author)}</strong><span>${esc(timeAgo(c.publishedAt))}</span></div>
        <p class="comment__text">${esc(c.text)}</p>
        ${c.likes ? `<span class="comment__likes">${icon("#i-thumb", "ico ico--14")} ${compact(c.likes)}</span>` : ""}
      </div>
    </div>`;
}

function watchHTML(video, comments, related, channel) {
  const liked = hasLiked(video.id);
  const disliked = getReactions().dislike.includes(video.id);
  const saved = isSaved(video.id);
  const metaBits = [
    video.views !== null ? fmtViews(video.views) : "",
    video.publishedAt ? timeAgo(video.publishedAt) : "",
    video.live ? "Live now" : ""
  ].filter(Boolean).join(" · ");

  const subLine = channel && channel.subscribers !== null
    ? `${compact(channel.subscribers)} subscribers`
    : "Watch on YouTube";

  return `
    <div class="watch">
      <div class="watch__main">
        <div class="player-frame ${IS_FILE ? "player-frame--local" : ""}">
          ${IS_FILE ? localFixHTML(video) : playerIFrame(video)}
        </div>

        <h1 class="watch__title">${esc(video.title)}</h1>

        <div class="channel-row">
          <div class="channel-row__id">
            ${avatarHTML(video.channelTitle, channel ? channel.avatar : (video.avatar || ""), "")}
            <div>
              <div class="channel-row__name">${esc(video.channelTitle)}</div>
              <div class="channel-row__subs">${esc(subLine)}</div>
            </div>
          </div>
          <div class="channel-row__actions">
            <a class="btn btn--soft btn--sm" href="https://www.youtube.com/channel/${esc(video.channelId)}"
               target="_blank" rel="noopener noreferrer">
              Subscribe ${icon("#i-external", "ico ico--14")}
            </a>
          </div>
        </div>

        <div class="actions">
          <div class="actions__group">
            <button class="pill-btn ${liked ? "is-on" : ""}" type="button" data-action="like" data-id="${esc(video.id)}"
                    aria-pressed="${liked}" aria-label="Like this video">
              ${icon("#i-thumb")}<span class="pill-btn__count" data-like-count>${video.likes !== null ? compact(video.likes + (liked ? 1 : 0)) : "Like"}</span>
            </button>
            <button class="pill-btn ${disliked ? "is-on" : ""}" type="button" data-action="dislike" data-id="${esc(video.id)}"
                    aria-pressed="${disliked}" aria-label="Dislike this video">
              ${icon("#i-thumb", "ico ico--flip")}<span class="sr-only">Dislike</span>
            </button>
          </div>

          <button class="pill-btn" type="button" data-action="share" data-id="${esc(video.id)}">
            ${icon("#i-share")}<span>Share</span>
          </button>

          <button class="pill-btn ${saved ? "is-on" : ""}" type="button" data-action="save-watch" data-id="${esc(video.id)}">
            ${icon("#i-bookmark")}<span data-save-label>${saved ? "Saved" : "Save"}</span>
          </button>

          <a class="pill-btn" href="https://www.youtube.com/watch?v=${esc(video.id)}" target="_blank" rel="noopener noreferrer">
            ${icon("#i-external")}<span>YouTube</span>
          </a>
        </div>

        <div class="desc" data-action="expand-desc" role="button" tabindex="0"
             aria-expanded="false" title="Toggle full description">
          <div class="desc__head"><span>${esc(metaBits)}</span></div>
          <div class="desc__body">${esc(video.description || "No description provided for this video.")}</div>
          <span class="desc__more" data-desc-more>Show more</span>
        </div>

        ${commentsSection(video, comments)}
      </div>

      <aside class="related" aria-label="Related videos">
        <div class="section-bar related__mobile-title"><h2 class="section-title">Up next</h2></div>
        ${related.length
          ? related.map((v) => miniVideoHTML(v)).join("")
          : `<p class="empty-note">Related videos are unavailable right now.</p>`}
      </aside>
    </div>`;
}

async function renderWatch(seq, id) {
  const el = view();
  if (!id) { el.innerHTML = invalidVideoState(); return; }
  if (!getApiKey()) { el.innerHTML = connectPrompt(); return; }

  el.innerHTML = watchSkeleton();

  try {
    const videos = await fetchVideoDetails([id]);
    if (isStale(seq)) return;
    const video = videos[0];
    if (!video) { el.innerHTML = invalidVideoState(); return; }

    remember(video);

    const [comments, related, channel] = await Promise.all([
      fetchComments(id, 20).catch(() => null),
      fetchRelated(video, 14).catch(() => []),
      fetchChannelInfo(video.channelId).catch(() => null)
    ]);
    if (isStale(seq)) return;

    addHistory(video);
    el.innerHTML = watchHTML(video, comments, related, channel);
    el.scrollTop = 0;
  } catch (e) {
    if (isStale(seq)) return;
    if (e && e.type === "no-key") el.innerHTML = connectPrompt();
    else el.innerHTML = errorState(e.type || "unknown", { code: e.message });
  }
}

/* ============================================================
   15. SHORTS
   ============================================================ */
const Shorts = {
  videos: [],
  index: 0,
  mode: null,          // 'api' (IFrame API) or 'fallback' (plain embeds)
  players: new Map(),  // index → YT.Player
  ytPromise: null,
  raf: 0
};

let shortsCache = null;

/** Public short-form feed — searched with the #shorts topic, enriched with stats. */
async function getShortsFeed() {
  if (shortsCache && Date.now() - shortsCache.t < SHORTS_CACHE_MS) return shortsCache.v;

  let videos = [];
  for (const q of ["#shorts", "shorts trending"]) {
    try {
      videos = await searchVideos(q, { max: 18, order: "viewCount" });
    } catch (e) {
      if (e instanceof ApiError && ["no-key", "auth", "quota", "network"].includes(e.type)) throw e;
      videos = [];
    }
    if (videos.length >= 8) break;
  }

  const vertical = videos.filter((v) => !v.duration || v.duration <= 180);
  const list = (vertical.length >= 6 ? vertical : videos).slice(0, 18);
  list.forEach(remember);
  shortsCache = { t: Date.now(), v: list };
  return list;
}

function shortHTML(video, index) {
  const liked = hasLiked(video.id);
  const saved = isSaved(video.id);
  const stats = [
    video.views !== null ? compact(video.views) + " views" : "",
    video.publishedAt ? timeAgo(video.publishedAt) : ""
  ].filter(Boolean).join(" · ");

  return `
    <section class="short is-paused" data-index="${index}" data-id="${esc(video.id)}" aria-label="Short ${index + 1}">
      <div class="short__media" id="shortm-${index}"
           ${video.thumb ? `style="background-image:url('${esc(video.thumb)}')"` : ""}>
        ${video.thumb ? "" : `<div class="thumb-fallback">${icon("#i-play")}</div>`}
      </div>
      <div class="short__shade"></div>

      <button class="short__tap" type="button" data-action="short-toggle" data-index="${index}" aria-label="Play or pause">
        <span class="short__tap-ico">${icon("#i-play", "ico ico--28")}</span>
      </button>

      <div class="short__top">
        <h2>${icon("#i-shorts", "ico ico--18")} Shorts</h2>
        <div class="short__nav">
          <button class="icon-btn" type="button" data-action="shorts-up" aria-label="Previous short">${icon("#i-chevron-up", "ico ico--18")}</button>
          <button class="icon-btn" type="button" data-action="shorts-down" aria-label="Next short">${icon("#i-chevron-down", "ico ico--18")}</button>
        </div>
      </div>

      <div class="short__info">
        <div class="short__channel">
          ${avatarHTML(video.channelTitle, video.avatar || "", "avatar--sm")}
          <span class="short__channel-name">${esc(video.channelTitle)}</span>
          <button class="short__follow" type="button" data-action="short-follow">Follow</button>
        </div>
        <p class="short__title">${esc(video.title)}</p>
        <p class="short__stats">${esc(stats)}</p>
      </div>

      <div class="short__rail">
        <button class="rail-btn ${liked ? "is-on" : ""}" type="button" data-action="like" data-id="${esc(video.id)}" aria-label="Like">
          <span class="rail-btn__ico">${icon("#i-thumb")}</span>
          <span data-like-count>${video.likes !== null ? compact(video.likes + (liked ? 1 : 0)) : "Like"}</span>
        </button>
        <button class="rail-btn" type="button" data-action="short-comments" data-id="${esc(video.id)}" aria-label="Comments">
          <span class="rail-btn__ico">${icon("#i-comment")}</span>
          <span>${video.commentCount !== null ? compact(video.commentCount) : "0"}</span>
        </button>
        <button class="rail-btn" type="button" data-action="share" data-id="${esc(video.id)}" aria-label="Share">
          <span class="rail-btn__ico">${icon("#i-share")}</span>
          <span>Share</span>
        </button>
        <button class="rail-btn ${saved ? "is-on" : ""}" type="button" data-action="save" data-id="${esc(video.id)}" aria-label="Save">
          <span class="rail-btn__ico">${icon("#i-bookmark")}</span>
          <span data-save-label>${saved ? "Saved" : "Save"}</span>
        </button>
      </div>
    </section>`;
}

async function renderShorts(seq) {
  const el = view();
  if (!getApiKey()) {
    el.innerHTML = `<div class="shorts"><div style="margin:auto;padding:24px">${connectPrompt()}</div></div>`;
    return;
  }
  el.innerHTML = `<div class="shorts">${loadingCenter("Loading Shorts…")}</div>`;

  try {
    const videos = await getShortsFeed();
    if (isStale(seq)) return;

    if (!videos.length) {
      el.innerHTML = `<div class="shorts">${emptyState({
        iconId: "#i-shorts",
        title: "No Shorts right now",
        text: "We couldn’t find short-form videos. Pull again in a bit.",
        actions: `<button class="btn btn--primary" data-action="retry">Retry</button>`
      })}</div>`;
      return;
    }

    Shorts.videos = videos;
    Shorts.index = 0;
    Shorts.mode = null;
    bumpStat("shorts");

    el.innerHTML = `
      <div class="shorts" id="shorts-root">
        <div class="shorts__feed" id="shorts-feed">
          ${videos.map((v, i) => shortHTML(v, i)).join("")}
        </div>
        <div class="shorts__hint">${IS_FILE ? "file:// mode — serve over HTTP to play Shorts" : "Scroll or swipe · Space to pause"}</div>
      </div>`;

    bindShortsFeed();
    activateShorts();
  } catch (e) {
    if (isStale(seq)) return;
    const html = e && e.type === "no-key"
      ? connectPrompt()
      : errorState(e.type || "unknown", { code: e.message });
    el.innerHTML = `<div class="shorts"><div style="margin:auto;padding:24px">${html}</div></div>`;
  }
}

function bindShortsFeed() {
  const feed = $("#shorts-feed");
  if (!feed) return;
  feed.addEventListener("scroll", () => {
    if (Shorts.raf) return;
    Shorts.raf = requestAnimationFrame(() => {
      Shorts.raf = 0;
      const h = feed.clientHeight || 1;
      const i = clamp(Math.round(feed.scrollTop / h), 0, Shorts.videos.length - 1);
      if (i !== Shorts.index) {
        Shorts.index = i;
        activateShorts();
      }
    });
  }, { passive: true });
}

function stepShorts(delta) {
  const feed = $("#shorts-feed");
  if (!feed) return;
  const next = clamp(Shorts.index + delta, 0, Shorts.videos.length - 1);
  feed.scrollTo({ top: next * feed.clientHeight, behavior: "smooth" });
}

function setShortPaused(index, paused) {
  const el = document.querySelector(`.short[data-index="${index}"]`);
  if (el) el.classList.toggle("is-paused", paused);
}

/** Loads the official YouTube IFrame API once (used to control Shorts playback). */
function loadYTApi() {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (Shorts.ytPromise) return Shorts.ytPromise;

  Shorts.ytPromise = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previous === "function") previous();
      resolve(window.YT);
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.onerror = () => reject(new Error("YouTube IFrame API failed to load"));
    document.head.appendChild(script);
    setTimeout(() => {
      if (!(window.YT && window.YT.Player)) reject(new Error("YouTube IFrame API timed out"));
    }, 6000);
  });
  return Shorts.ytPromise;
}

async function ensureShortPlayer(index) {
  if (Shorts.players.has(index)) return Shorts.players.get(index);
  const video = Shorts.videos[index];
  const mount = document.getElementById(`shortm-${index}`);
  if (!video || !mount) return null;

  const YT = await loadYTApi();
  mount.innerHTML = "";
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;inset:0";
  mount.appendChild(host);

  const player = new YT.Player(host, {
    videoId: video.id,
    playerVars: {
      autoplay: 0, controls: 0, modestbranding: 1, rel: 0,
      playsinline: 1, iv_load_policy: 3, fs: 0, disablekb: 1
    },
    events: {
      onReady: () => {
        if (index === Shorts.index) { safePlay(player); setShortPaused(index, false); }
      },
      onStateChange: (e) => {
        if (e.data === 1) {                       // playing
          Shorts.players.forEach((p, k) => { if (k !== index) tryPause(p); });
          setShortPaused(index, false);
        } else if (e.data === 2 || e.data === 0) { // paused / ended
          setShortPaused(index, true);
        }
      },
      onError: () => setShortPaused(index, true)  // poster stays visible, tap overlay returns
    }
  });

  Shorts.players.set(index, player);
  return player;
}

function safePlay(player) { try { player.playVideo(); } catch { /* autoplay blocked */ } }
function tryPause(player) { try { player.pauseVideo(); } catch { /* already gone */ } }

function cleanupShortPlayers(active) {
  Shorts.players.forEach((player, index) => {
    if (Math.abs(index - active) > 1) {
      try { player.destroy(); } catch { /* noop */ }
      Shorts.players.delete(index);
    }
  });
}

/** Fallback when the IFrame API can't load: one plain embed, swapped on scroll. */
function mountFallbackShort(active) {
  if (IS_FILE) return;
  Shorts.players.forEach((player) => { try { player.destroy(); } catch { /* noop */ } });
  Shorts.players.clear();

  Shorts.videos.forEach((video, index) => {
    const mount = document.getElementById(`shortm-${index}`);
    if (!mount) return;
    if (Math.abs(index - active) > 1) { mount.innerHTML = ""; return; }
    if (index !== active) { mount.innerHTML = ""; setShortPaused(index, true); return; }

    mount.innerHTML = `
      <iframe src="${embedSrc(esc(video.id), `playsinline=1&controls=0&modestbranding=1&rel=0&loop=1&playlist=${esc(video.id)}&autoplay=1`)}"
              title="${esc(video.title)}"
              allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
    setShortPaused(index, false);
  });
}

async function activateShorts() {
  if (!$("#shorts-feed")) return;
  if (IS_FILE) return;   // YouTube blocks file:// embeds (Error 153) — poster + hint stay
  const i = Shorts.index;

  if (Shorts.mode === "fallback") { mountFallbackShort(i); return; }
  try {
    await Promise.all([i - 1, i, i + 1]
      .filter((n) => n >= 0 && n < Shorts.videos.length)
      .map(ensureShortPlayer));
    Shorts.mode = "api";
    Shorts.players.forEach((player, index) => {
      if (index === i) { safePlay(player); setShortPaused(index, false); }
      else tryPause(player);
    });
    cleanupShortPlayers(i);
  } catch {
    Shorts.mode = "fallback";
    mountFallbackShort(i);
  }
}

function toggleShort(index) {
  if (IS_FILE) { toast("Videos can’t play from a local file — serve over HTTP", "info"); return; }
  const player = Shorts.players.get(index);
  if (Shorts.mode !== "fallback" && player && typeof player.getPlayerState === "function") {
    try {
      if (player.getPlayerState() === 1) { player.pauseVideo(); setShortPaused(index, true); }
      else { player.playVideo(); setShortPaused(index, false); }
      return;
    } catch { /* fall through to fallback toggle */ }
  }
  const mount = document.getElementById(`shortm-${index}`);
  const paused = mount && mount.classList.contains("is-paused") !== false;
  const isPaused = !mount || mount.closest(".short").classList.contains("is-paused");
  if (isPaused) mountFallbackShort(index);
  else {
    if (mount) mount.innerHTML = "";
    setShortPaused(index, true);
  }
}

function teardownShorts() {
  Shorts.players.forEach((player) => { try { player.destroy(); } catch { /* noop */ } });
  Shorts.players.clear();
  Shorts.videos = [];
  Shorts.index = 0;
  Shorts.mode = null;
  if (Shorts.raf) { cancelAnimationFrame(Shorts.raf); Shorts.raf = 0; }
}

/* ============================================================
   16. LIBRARY
   ============================================================ */
let libraryTab = "history";

function setLibraryTab(tab) {
  if (!["history", "saved"].includes(tab)) return;
  libraryTab = tab;
  renderLibrary();
}

function libraryRowHTML(video, opts) {
  remember(video);
  const meta = opts.meta;
  return `
    <div class="list-row" data-watch="${esc(video.id)}" tabindex="0" role="link" aria-label="Play ${esc(video.title)}">
      <div class="list-row__thumb">
        ${thumbImg(video)}
        ${video.duration ? `<span class="card__dur">${esc(fmtDuration(video.duration))}</span>` : ""}
      </div>
      <div class="list-row__body">
        <h3 class="list-row__title">${esc(video.title)}</h3>
        <p class="list-row__meta">${esc(meta)}</p>
      </div>
      <div class="list-row__acts">
        <button class="icon-btn" type="button" data-action="${opts.removeAction}" data-id="${esc(video.id)}"
                aria-label="Remove" title="Remove">${icon("#i-trash", "ico ico--18")}</button>
      </div>
    </div>`;
}

function renderLibrary() {
  const el = view();
  const history = getHistory();
  const saved = getSaved();
  const recent = history.slice(0, 6);
  const list = libraryTab === "history" ? history : saved;

  let body;
  if (!list.length) {
    body = libraryTab === "history"
      ? emptyState({
          iconId: "#i-clock",
          title: "No watch history yet",
          text: "Videos you watch show up here automatically — stored only on this device.",
          actions: `<a class="btn btn--primary" href="#/home">Browse Home</a>`
        })
      : emptyState({
          iconId: "#i-bookmark",
          title: "Nothing saved yet",
          text: "Tap the bookmark on any video to keep it in your library.",
          actions: `<a class="btn btn--primary" href="#/home">Find videos</a>`
        });
  } else {
    body = `<div class="list">${list.map((v) => libraryRowHTML(v, libraryTab === "history"
      ? { meta: `Watched ${timeAgoTs(v.watchedAt)} · ${v.channelTitle}`, removeAction: "remove-history" }
      : { meta: `Saved ${timeAgoTs(v.savedAt)} · ${v.channelTitle}`, removeAction: "remove-saved" })).join("")}</div>`;
  }

  el.innerHTML = `
    <div class="page-head">
      <div>
        <p class="eyebrow">On this device</p>
        <h1 class="page-title">Library</h1>
        <p class="page-sub">History and saved videos live in your browser — never on a server.</p>
      </div>
      ${history.length ? `<button class="btn btn--ghost btn--sm" type="button" data-action="clear-history">${icon("#i-trash", "ico ico--16")} Clear history</button>` : ""}
    </div>

    ${recent.length ? `
      <div class="section-bar"><h2 class="section-title">Jump back in</h2></div>
      <div class="strip">${recent.map((v) => videoCardHTML(v)).join("")}</div>` : ""}

    <div class="tabs" role="tablist" aria-label="Library sections" style="margin-top:26px">
      <button class="tab ${libraryTab === "history" ? "is-active" : ""}" role="tab" type="button"
              aria-selected="${libraryTab === "history"}" data-action="tab" data-tab="history">
        History ${history.length ? `<span class="tab__count">${history.length}</span>` : ""}
      </button>
      <button class="tab ${libraryTab === "saved" ? "is-active" : ""}" role="tab" type="button"
              aria-selected="${libraryTab === "saved"}" data-action="tab" data-tab="saved">
        Saved ${saved.length ? `<span class="tab__count">${saved.length}</span>` : ""}
      </button>
    </div>

    ${body}`;
}

/* ============================================================
   17. PROFILE
   ============================================================ */
function renderProfile() {
  const el = view();
  const name = Store.get(LS.USER, "Guest");
  const history = getHistory();
  const saved = getSaved();
  const stats = getStats();
  const created = Store.get(LS.CREATED, Date.now());
  const days = Math.max(1, Math.ceil((Date.now() - created) / 86400000));
  const theme = document.documentElement.dataset.theme;

  const statCard = (iconId, value, label) => `
    <div class="stat">
      <span class="stat__ico">${icon(iconId, "ico ico--18")}</span>
      <span class="stat__value">${esc(value)}</span>
      <span class="stat__label">${esc(label)}</span>
    </div>`;

  el.innerHTML = `
    <div class="profile">
      <section class="profile__head">
        <div class="profile__ident">
          ${avatarHTML(name, "", "avatar--xl")}
          <div>
            <h1 class="profile__name">${esc(name)}</h1>
            <span class="profile__badge">${icon("#i-check", "ico ico--14")} Local profile · stored on this device</span>
          </div>
        </div>

        <div class="profile__actions" id="profile-actions">
          <button class="btn btn--soft btn--sm" type="button" data-action="edit-name">
            ${icon("#i-pencil", "ico ico--16")} Edit name
          </button>
          <div class="seg" role="group" aria-label="Theme">
            <button class="seg__btn ${theme === "dark" ? "is-active" : ""}" type="button" data-action="set-theme" data-theme-value="dark">
              ${icon("#i-moon")} Dark
            </button>
            <button class="seg__btn ${theme === "light" ? "is-active" : ""}" type="button" data-action="set-theme" data-theme-value="light">
              ${icon("#i-sun")} Light
            </button>
          </div>
          <button class="btn btn--danger btn--sm" type="button" data-action="reset-data">
            ${icon("#i-trash", "ico ico--16")} Reset app data
          </button>
        </div>

        <div class="profile__edit" id="name-editor" hidden>
          <input class="input" id="name-input" type="text" maxlength="24" value="${esc(name)}"
                 aria-label="New display name" autocomplete="off">
          <button class="btn btn--primary" type="button" data-action="save-name">Save</button>
          <button class="btn btn--ghost" type="button" data-action="cancel-name">Cancel</button>
        </div>
      </section>

      <section class="stats-grid" aria-label="App statistics">
        ${statCard("#i-clock", String(stats.watched || 0), "Videos watched")}
        ${statCard("#i-bookmark", String(saved.length), "Saved videos")}
        ${statCard("#i-search", String(stats.searches || 0), "Searches run")}
        ${statCard("#i-sparkles", `${days}d`, days === 1 ? "Day with Luma" : "Days with Luma")}
      </section>

      <section class="panel">
        <div class="panel__head">
          <h2 class="panel__title">Saved videos</h2>
          <a class="text-link" href="#/library">Open library ${icon("#i-arrow-right", "ico ico--14")}</a>
        </div>
        ${saved.length
          ? `<div class="feed-grid">${saved.slice(0, 8).map((v) => videoCardHTML(v)).join("")}</div>`
          : `<p class="empty-note">Nothing saved yet — hit Save on any video card or watch page.</p>`}
      </section>

      <section class="panel">
        <div class="panel__head">
          <h2 class="panel__title">Recently watched</h2>
          <a class="text-link" href="#/library">Full history ${icon("#i-arrow-right", "ico ico--14")}</a>
        </div>
        ${history.length
          ? `<div class="list">${history.slice(0, 5).map((v) => libraryRowHTML(v, {
              meta: `Watched ${timeAgoTs(v.watchedAt)} · ${v.channelTitle}`,
              removeAction: "remove-history"
            })).join("")}</div>`
          : `<p class="empty-note">Your watch history is empty — it builds up as you explore.</p>`}
      </section>
    </div>`;
}

function startEditName() {
  const editor = $("#name-editor");
  const actions = $("#profile-actions");
  if (!editor) return;
  if (actions) actions.hidden = true;
  editor.hidden = false;
  const input = $("#name-input");
  if (input) { input.focus(); input.select(); }
}

function saveEditedName() {
  const input = $("#name-input");
  if (!input) return;
  const value = input.value.trim().replace(/\s+/g, " ");
  if (!value) { toast("Name can’t be empty", "err"); input.focus(); return; }
  Store.set(LS.USER, value);
  syncIdentity();
  toast(`Hey there, ${value}`, "ok");
  renderProfile();
}

function syncIdentity() {
  const btn = $("#avatar-btn");
  if (btn) btn.textContent = initials(Store.get(LS.USER, "Luma"));
}

/* ============================================================
   18. COMMENTS SHEET (Shorts + anywhere)
   ============================================================ */
async function openSheet(videoId) {
  const sheet = $("#sheet");
  const body = $("#sheet-body");
  if (!sheet || !body) return;

  sheet.hidden = false;
  document.body.style.overflow = "hidden";
  body.innerHTML = skeletonRows(4);

  try {
    const list = await fetchComments(videoId, 25);
    body.innerHTML = list.length
      ? list.map(commentHTML).join("")
      : `<p class="empty-note">No comments available for this video.</p>`;
  } catch (e) {
    body.innerHTML = emptyState({
      iconId: "#i-comment",
      title: "Comments unavailable",
      text: e && e.type === "quota"
        ? "Today’s API quota is used up — comments will return after the reset."
        : "Comments couldn’t be loaded right now. Check your connection and API key."
    });
  }
}

function closeSheet() {
  const sheet = $("#sheet");
  if (!sheet || sheet.hidden) return;
  sheet.hidden = true;
  document.body.style.overflow = "";
}

function bindSheet() {
  const sheet = $("#sheet");
  if (!sheet) return;
  sheet.addEventListener("click", (e) => {
    if (e.target.closest("[data-sheet-close]")) closeSheet();
  });
}

/* ============================================================
   19. BOOT
   ============================================================ */
/** Persistent tip when running as a local file — videos can't play from file://. */
function maybeFileBanner() {
  if (!IS_FILE || Store.get(LS.FILE_BANNER)) return;
  if (document.getElementById("file-banner")) return;

  const b = document.createElement("aside");
  b.className = "file-banner";
  b.id = "file-banner";
  b.setAttribute("role", "status");
  b.innerHTML = `
    <span class="file-banner__ico">${icon("#i-alert", "ico ico--18")}</span>
    <div class="file-banner__body">
      <strong>Local file mode — videos won’t play</strong>
      <span>Serve this folder: <code>python -m http.server 8000</code></span>
    </div>
    <button class="icon-btn" type="button" data-action="copy-cmd" data-cmd="python -m http.server 8000" aria-label="Copy command">${icon("#i-copy", "ico ico--16")}</button>
    <button class="icon-btn" type="button" data-action="dismiss-file-banner" aria-label="Dismiss tip">${icon("#i-close", "ico ico--16")}</button>`;
  b.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "copy-cmd") copyCommand(btn.dataset.cmd || "");
    else if (btn.dataset.action === "dismiss-file-banner") {
      Store.set(LS.FILE_BANNER, 1);
      b.remove();
    }
  });
  document.body.appendChild(b);
}

function enterApp() {
  $("#app").hidden = false;
  syncIdentity();
  maybeFileBanner();
  if (!getApiKey()) {
    showSetup();
    route();               // render a friendly "connect" state behind the setup card
  } else {
    hideSetup();
    route();
  }
}

function bindGlobalKeys() {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeSuggest();
      closeSheet();
    }
    if (currentRoute.name !== "shorts") return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    if (e.key === "ArrowDown" || e.key === "PageDown") { e.preventDefault(); stepShorts(1); }
    else if (e.key === "ArrowUp" || e.key === "PageUp") { e.preventDefault(); stepShorts(-1); }
    else if (e.key === " ") { e.preventDefault(); toggleShort(Shorts.index); }
  });

  // close search suggestions when clicking anywhere else
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-wrap")) closeSuggest();
  });
}

function init() {
  try {
    setTheme(Store.get(LS.THEME, "dark"));
    bindOnboarding();
    bindSetup();
    bindShell();
    bindSheet();
    bindGlobalKeys();
    syncIdentity();

    const existingName = Store.get(LS.USER);
    if (!existingName) showOnboarding();
    else enterApp();
  } catch (e) {
    console.error("Boot failed:", e);
    document.body.innerHTML = `
      <div class="state" style="min-height:100dvh">
        <div class="state__icon state__icon--danger">${icon("#i-alert")}</div>
        <h1 class="state__title">Luma couldn’t start</h1>
        <p class="state__text">${esc(e && e.message ? e.message : "Unexpected startup error.")}</p>
        <div class="state__actions">
          <button class="btn btn--primary" type="button" onclick="location.reload()">Reload app</button>
        </div>
      </div>`;
  }
}

document.addEventListener("DOMContentLoaded", init);

