"use strict";
/* Віфанія — пісні: a phone app for the shared VisioBible songbooks.
 * It talks to the private GitHub repository directly with the user's token.
 * Songbooks are songbooks/<name>.json, written in exactly the format VisioSync
 * uses, so church computers pick changes up through their normal sync. */

const DEFAULT_REPO = "vifaniyamedia-ux/vifaniya-storage";
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const root = $("#view");
let view = root; // where the current screen draws (a pane on wide screens)
const wideMQ = matchMedia("(min-width: 1024px)");
const isWide = () => wideMQ.matches;

/* ---------------------------------------------------------------- settings */

const store = {
  get(k, d) { try { const v = localStorage.getItem("vs." + k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem("vs." + k, JSON.stringify(v)); } catch (_) {} },
};
const cfg = () => ({
  repo: store.get("repo", DEFAULT_REPO),
  token: store.get("token", ""),
  name: store.get("name", ""),
  api: store.get("api", "https://api.github.com"),
  readOnly: store.get("readOnly", false),
});
// test servers only: ?api=http://127.0.0.1:port
{
  const p = new URLSearchParams(location.search).get("api");
  if (p && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(p)) store.set("api", p);
}

/* ---------------------------------------------------------------- GitHub */

class HTTPError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function ghPath(p) { return p.split("/").map(encodeURIComponent).join("/"); }

async function gh(path, { method = "GET", body, raw = false } = {}) {
  const c = cfg();
  if (!c.token) throw new HTTPError(401, "Вставте токен у налаштуваннях");
  const [owner, repo] = c.repo.split("/");
  const r = await fetch(`${c.api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`, {
    method,
    cache: "no-store",
    headers: {
      Authorization: "Bearer " + c.token,
      Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let m = "";
    try { m = (await r.json()).message || ""; } catch (_) {}
    if (r.status === 401) throw new HTTPError(401, "Токен не підходить або закінчився. Перевірте налаштування.");
    if (r.status === 403 || (r.status === 404 && method !== "GET")) throw new HTTPError(403, "Цей токен дає доступ лише на перегляд.");
    if (r.status === 404) throw new HTTPError(404, "Не знайдено: " + (m || path));
    throw new HTTPError(r.status, m || "Помилка сервера " + r.status);
  }
  return raw ? r.text() : r.json();
}

const enc = new TextEncoder();
async function blobSHA(text) {
  const bytes = enc.encode(text);
  const head = enc.encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(head.length + bytes.length);
  all.set(head); all.set(bytes, head.length);
  const h = await crypto.subtle.digest("SHA-1", all);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function b64(text) {
  const bytes = enc.encode(text);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/* data cache, for use without internet */
async function cachePut(key, text) {
  try { const c = await caches.open("vs-data"); await c.put("/data/" + encodeURIComponent(key), new Response(text)); } catch (_) {}
}
async function cacheGet(key) {
  try { const c = await caches.open("vs-data"); const r = await c.match("/data/" + encodeURIComponent(key)); return r ? r.text() : null; } catch (_) { return null; }
}
function setOffline(on) { $("#offline").classList.toggle("hidden", !on); }
const isNetErr = (e) => !(e instanceof HTTPError);

async function listBooks() {
  try {
    const list = await gh("/contents/songbooks");
    const books = list.filter((f) => f.name.endsWith(".json")).map((f) => ({ name: f.name.replace(/\.json$/, ""), sha: f.sha }));
    store.set("books", books);
    setOffline(false);
    return books;
  } catch (e) {
    if (isNetErr(e)) { setOffline(true); return store.get("books", []); }
    throw e;
  }
}

// loadBook returns {book, sha} of the current server copy.
async function loadBook(name, fresh = false) {
  const path = "songbooks/" + name + ".json";
  try {
    let sha;
    for (let i = 0; i < 3; i++) {
      const dir = await gh("/contents/songbooks"); // small listing with the current file version
      const f = dir.find((x) => x.name === name + ".json");
      if (!f) throw new HTTPError(404, "Пісенника «" + name + "» немає в сховищі");
      sha = f.sha;
      const text = await gh("/contents/" + ghPath(path), { raw: true });
      if ((await blobSHA(text)) === sha) {
        await cachePut(path, JSON.stringify({ sha, text }));
        setOffline(false);
        return { book: JSON.parse(text), sha };
      }
    }
    throw new Error("Пісенник саме змінюється, спробуйте ще раз");
  } catch (e) {
    if (isNetErr(e) && !fresh) {
      const c = await cacheGet(path);
      if (c) { setOffline(true); const { sha, text } = JSON.parse(c); return { book: JSON.parse(text), sha, offline: true }; }
    }
    throw e;
  }
}

/* same JSON as VisioSync writes (Go encoding/json, 2-space indent) */
function canonSong(s) {
  const o = { id: s.id, title: s.title };
  for (const k of ["altTitle", "wordsAuthor", "musicAuthor", "date", "meta"]) if (s[k]) o[k] = s[k];
  o.chunks = (s.chunks || []).map((c) => { const x = { name: c.name || "", text: c.text || "" }; if (c.flag) x.flag = c.flag; return x; });
  return o;
}
function canonBook(b) {
  const o = { format: b.format, title: b.title, shortName: b.shortName };
  for (const k of ["publisher", "date", "notes"]) if (b[k]) o[k] = b[k];
  o.songs = b.songs.map(canonSong);
  o.categories = (b.categories || []).map((c) => ({ name: c.name, songs: c.songs || [] }));
  return o;
}
const songKey = (s) => JSON.stringify(canonSong(s));
function normText(t) {
  t = (t || "").replace(/\r\n?/g, "\n").replace(/[\n ]+$/, "");
  return t ? t.replace(/\n/g, "\r\n") + "\r\n" : "";
}
function newID() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// saveSong applies one change to the server copy, retrying if someone else
// saved the songbook meanwhile. base is songKey() of the song as opened.
async function saveSong(name, song, base, del = false) {
  const path = "songbooks/" + name + ".json";
  const host = cfg().name || "Телефон";
  for (let attempt = 0; attempt < 5; attempt++) {
    const { book, sha } = await loadBook(name, true);
    if (book.format > 1) throw new Error("Цей пісенник записано новішою версією. Оновіть сторінку.");
    const i = book.songs.findIndex((x) => x.id === song.id);
    let verb;
    if (!song.id || (base === "" && i < 0)) {
      if (!song.id) song.id = newID();
      book.songs.push(song);
      verb = "нова пісня";
    } else if (i < 0) {
      throw new Error("Цієї пісні вже немає (її видалили на іншому пристрої)");
    } else if (base && songKey(book.songs[i]) !== base && songKey(book.songs[i]) !== songKey(song)) {
      throw new Error("Цю пісню щойно змінили на іншому пристрої. Відкрийте її знову.");
    } else if (del) {
      book.songs.splice(i, 1);
      for (const c of book.categories || []) c.songs = (c.songs || []).filter((id) => id !== song.id);
      verb = "видалено";
    } else {
      if (songKey(book.songs[i]) === songKey(song)) return song;
      book.songs[i] = song;
      verb = "змінено";
    }
    const text = JSON.stringify(canonBook(book), null, 2) + "\n";
    try {
      await gh("/contents/" + ghPath(path), {
        method: "PUT",
        body: { message: `${host}: ${name}: ${verb} — ${song.title}`, content: b64(text), sha },
      });
      await cachePut(path, JSON.stringify({ sha: await blobSHA(text), text }));
      return song;
    } catch (e) {
      if (e.status === 409 || e.status === 422) continue; // changed meanwhile: merge again
      if (e.status === 403) store.set("readOnly", true);
      throw e;
    }
  }
  throw new Error("Сервер зайнятий, спробуйте ще раз");
}

/* ---------------------------------------------------------------- UI helpers */

let toastTimer;
function toast(msg, kind = "") {
  const t = $("#toast");
  t.textContent = msg; t.className = "toast " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), kind === "err" ? 5000 : 2800);
}
function ask(title, text, yes = "Так", danger = false) {
  return new Promise((res) => {
    $("#sheetTitle").textContent = title; $("#sheetText").textContent = text;
    const y = $("#sheetYes"); y.textContent = yes; y.className = "btn " + (danger ? "danger" : "primary");
    $("#sheet").classList.remove("hidden");
    const done = (v) => { $("#sheet").classList.add("hidden"); res(v); };
    y.onclick = () => done(true); $("#sheetNo").onclick = () => done(false);
  });
}
function setBar(title, sub = "", { back = null, actions = "" } = {}) {
  $("#barTitle").textContent = title; $("#barSub").textContent = sub;
  const b = $("#barBack");
  b.classList.toggle("invisible", !back);
  b.onclick = back ? () => (typeof back === "string" ? (location.hash = back) : back()) : null;
  $("#barActions").innerHTML = actions;
}
function setTab(t) { document.querySelectorAll(".tabs a, .side-nav a").forEach((a) => a.classList.toggle("active", a.dataset.tab === t)); }
function toTop() { view.scrollTop = 0; if (!isWide()) scrollTo(0, 0); }
const spinner = () => { view.innerHTML = '<div class="spinner"></div>'; };
function errorView(e, retry) {
  view.innerHTML = `<div class="empty"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/></svg><p>${esc(e.message)}</p>${retry ? '<button class="btn" id="retry">Спробувати ще раз</button>' : ""}${e.status === 401 ? '<p><a href="#/settings">Відкрити налаштування</a></p>' : ""}</div>`;
  if (retry) $("#retry").onclick = retry;
}
const icons = {
  chev: '<svg class="go" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="m18 15-6-6-6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
  del: '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14"/></svg>',
  aminus: '<svg viewBox="0 0 24 24"><path d="M4 18 9 6l5 12M5.5 14h7M16 12h5"/></svg>',
  aplus: '<svg viewBox="0 0 24 24"><path d="M4 18 9 6l5 12M5.5 14h7M16 12h5M18.5 9.5v5"/></svg>',
  book: '<svg viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM20 17v4H6.5"/></svg>',
  text: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  music: '<svg viewBox="0 0 24 24"><path d="M9 18V6l11-2v12M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3zm11-2a3 3 0 1 1-3-3 3 3 0 0 1 3 3z"/></svg>',
};
const chunkColors = { "куплет": "#5b8def", "приспів": "#2fb37c", "заспів": "#e7a23a", "міст": "#b05ce0", "вступ": "#46b5c8", "кінцівка": "#e3575c" };
function colorOf(name) { const n = (name || "").toLowerCase(); for (const k in chunkColors) if (n.includes(k)) return chunkColors[k]; return "#9a98b4"; }
const norm = (s) => (s || "").toLowerCase().replace(/ё/g, "е").replace(/[’'`ʼ]/g, "'");
const lines = (t) => (t || "").replace(/\r\n/g, "\n").replace(/\n$/, "");
function firstLine(s) { for (const c of s.chunks || []) { const l = (c.text || "").split(/\r?\n/).find((x) => x.trim()); if (l) return l.trim(); } return ""; }

/* ---------------------------------------------------------------- state */

const state = { name: "", book: null, sha: "", filter: "", scroll: 0, all: false };
const books = {}; // name -> {book, sha}: every songbook loaded so far
function dropBook(name) { delete books[name]; if (!name || state.name === name) { state.book = null; } if (!name) for (const k in books) delete books[k]; }
let editing = null; // {song, base, isNew, dirty}

async function getBook(name) {
  if (!books[name]) {
    const r = await loadBook(name);
    books[name] = { book: r.book, sha: r.sha };
    const meta = store.get("bookMeta", {});
    meta[name] = { title: r.book.title, count: r.book.songs.length };
    store.set("bookMeta", meta);
    renderSide();
  }
  return books[name];
}
async function ensureBook(name) {
  if (state.name === name && state.book) return;
  if (!books[name]) spinner();
  const keep = state.name === name || state.all ? state.filter : "";
  const r = await getBook(name);
  Object.assign(state, { name, book: r.book, sha: r.sha, filter: keep, scroll: 0 });
  const meta = store.get("bookMeta", {});
  meta[name] = { title: r.book.title, count: r.book.songs.length };
  store.set("bookMeta", meta);
  hideUpdate();
}

/* "new changes" banner: checked when the app comes back to the screen and every minute */
function hideUpdate() { $("#update").classList.add("hidden"); }
async function checkUpdates() {
  if (!state.name || !state.sha || editing || document.hidden || !cfg().token) return;
  try {
    const dir = await gh("/contents/songbooks");
    const f = dir.find((x) => x.name === state.name + ".json");
    if (f && f.sha !== state.sha) $("#update").classList.remove("hidden");
  } catch (_) {}
}
$("#updateBtn").onclick = async () => {
  hideUpdate();
  dropBook(state.name);
  delete root.dataset.book; // redraw the list too
  await route();
  toast("Пісні оновлено", "ok");
};
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkUpdates(); });
setInterval(checkUpdates, 60000);

/* ---------------------------------------------------------------- search */

function matchSong(s, n, q) {
  return String(n) === q || norm(s.title).includes(q) || norm(s.altTitle).includes(q) || (s.chunks || []).some((c) => norm(c.text).includes(q));
}
// searchAll looks through every songbook (loading the ones not opened yet).
async function searchAll(q) {
  const out = [];
  for (const b of store.get("books", [])) {
    let r;
    try { r = await getBook(b.name); } catch (_) { continue; }
    r.book.songs.forEach((s, i) => { if (matchSong(s, i + 1, q)) out.push({ name: b.name, title: r.book.title, s, n: i + 1 }); });
  }
  return out;
}
function songRow(name, s, n, bookTitle, active) {
  return `<li data-id="${esc(s.id)}" data-b="${esc(name)}" class="${active ? "active" : ""}"><span class="n">${n}</span><span class="txt"><div class="t">${esc(s.title.trim() || "без назви")}</div><div class="f">${bookTitle ? `<b>${esc(bookTitle)}</b> · ` : ""}${esc(firstLine(s))}</div></span></li>`;
}

/* ---------------------------------------------------------------- sidebar (wide screens) */

function renderSide() {
  const box = $("#sideBooks");
  if (!box) return;
  const meta = store.get("bookMeta", {});
  const list = store.get("books", []);
  box.innerHTML = list.map((b) => `<a href="#/b/${encodeURIComponent(b.name)}" data-book="${esc(b.name)}" class="${state.name === b.name && location.hash.startsWith("#/b/") ? "active" : ""}">${icons.book}<span>${esc((meta[b.name] || {}).title || b.name)}</span><small>${(meta[b.name] || {}).count || ""}</small></a>`).join("");
}

/* ---------------------------------------------------------------- screens */

async function screenBooks() {
  setTab("songs");
  setBar("Пісенники");
  spinner();
  let list;
  try { list = await listBooks(); } catch (e) { return errorView(e, screenBooks); }
  renderSide();
  if (list.length === 1) { location.replace("#/b/" + encodeURIComponent(list[0].name)); return; }
  if (!list.length) { view.innerHTML = '<div class="empty"><p>У сховищі ще немає пісенників.</p></div>'; return; }
  const meta = store.get("bookMeta", {});
  view.innerHTML = `
    <div class="search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg><input id="qa" type="search" placeholder="Пошук у всіх пісенниках" autocomplete="off" value="${esc(state.allQ || "")}"></div>
    <div id="allRes"></div>
    <div id="bookList"><div class="section-title">Пісенники</div><ul class="list">${list.map((b) => { const m = meta[b.name] || {}; return `<li data-b="${esc(b.name)}"><span class="plan-icon">${icons.book}</span><span class="txt"><div class="t">${esc(m.title || b.name)}</div>${m.count ? `<div class="f">${m.count} пісень</div>` : ""}</span>${icons.chev}</li>`; }).join("")}</ul></div>`;
  $("#bookList").onclick = (e) => { const li = e.target.closest("li[data-b]"); if (li) location.hash = "#/b/" + encodeURIComponent(li.dataset.b); };
  let seq = 0;
  const run = async () => {
    const q = norm(($("#qa").value || "").trim());
    state.allQ = $("#qa").value;
    $("#bookList").classList.toggle("hidden", !!q);
    if (!q) { $("#allRes").innerHTML = ""; return; }
    const my = ++seq;
    $("#allRes").innerHTML = '<div class="spinner"></div>';
    const res = await searchAll(q);
    if (my !== seq) return;
    const shown = res.slice(0, 300);
    $("#allRes").innerHTML = `<div class="count">Знайдено: ${res.length}</div><ul class="list">${shown.map((r) => songRow(r.name, r.s, r.n, r.title)).join("") || '<li class="muted">Нічого не знайдено</li>'}</ul>`;
  };
  $("#qa").oninput = run;
  $("#allRes").onclick = (e) => { const li = e.target.closest("li[data-id]"); if (li) location.hash = `#/b/${encodeURIComponent(li.dataset.b)}/s/${li.dataset.id}`; };
  if (state.allQ) run();
}

async function screenSongs(name, activeId) {
  setTab("songs");
  try { await ensureBook(name); } catch (e) { setBar(name, "", { back: "#/" }); return errorView(e, () => screenSongs(name)); }
  renderSide();
  const many = store.get("books", []).length > 1;
  setBar(state.book.title || name, `${state.book.songs.length} пісень`, { back: many && !isWide() ? "#/" : null });
  view.innerHTML = `
    <div class="search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg><input id="q" type="search" placeholder="Назва, рядок пісні або номер" value="${esc(state.filter)}" autocomplete="off"></div>
    ${many ? `<label class="all-toggle"><input type="checkbox" id="allBooks" ${state.all ? "checked" : ""}><span>Шукати в усіх пісенниках</span></label>` : ""}
    <div class="count" id="count"></div>
    <ul class="list" id="songs"></ul>
    ${cfg().readOnly ? "" : `<button class="fab" id="fab" aria-label="Нова пісня">${icons.plus}Пісня</button>`}`;
  let seq = 0;
  const render = async () => {
    const q = norm(state.filter.trim());
    const cur = location.hash.match(/\/s\/([^/]+)/);
    const act = cur ? cur[1] : activeId;
    if (q && state.all && many) {
      const my = ++seq;
      $("#count").textContent = "Шукаю…";
      const res = await searchAll(q);
      if (my !== seq) return;
      $("#count").textContent = `Знайдено в усіх пісенниках: ${res.length}`;
      $("#songs").innerHTML = res.slice(0, 300).map((r) => songRow(r.name, r.s, r.n, r.title, r.s.id === act)).join("") || '<li class="muted">Нічого не знайдено</li>';
      return;
    }
    seq++;
    let items = state.book.songs.map((s, i) => ({ s, n: i + 1 }));
    if (q) items = items.filter(({ s, n }) => matchSong(s, n, q));
    $("#count").textContent = q ? `Знайдено: ${items.length}` : "";
    const shown = items.slice(0, q ? 300 : 1000);
    $("#songs").innerHTML = shown.map(({ s, n }) => songRow(name, s, n, "", s.id === act)).join("")
      + (items.length > shown.length ? `<li class="muted small">… ще ${items.length - shown.length}. Уточніть пошук.</li>` : "")
      + (!items.length ? '<li class="muted">Нічого не знайдено</li>' : "");
  };
  render();
  $("#q").oninput = (e) => { state.filter = e.target.value; render(); };
  if ($("#allBooks")) $("#allBooks").onchange = (e) => { state.all = e.target.checked; render(); };
  $("#songs").onclick = (e) => {
    const li = e.target.closest("li[data-id]");
    if (!li) return;
    state.scroll = scrollY;
    location.hash = `#/b/${encodeURIComponent(li.dataset.b)}/s/${li.dataset.id}`;
  };
  if ($("#fab")) $("#fab").onclick = () => (location.hash = `#/b/${encodeURIComponent(name)}/new`);
  if (!isWide()) requestAnimationFrame(() => scrollTo(0, state.scroll));
}

function screenSong(name, id) {
  setTab("songs");
  const i = state.book.songs.findIndex((s) => s.id === id);
  if (i < 0) { location.replace("#/b/" + encodeURIComponent(name)); return; }
  const s = state.book.songs[i];
  const size = store.get("lyrics", 19);
  document.documentElement.style.setProperty("--lyrics", size + "px");
  setBar("№ " + (i + 1), state.book.title, {
    back: "#/b/" + encodeURIComponent(name),
    actions: `<button class="bar-btn" id="zm" aria-label="Менший шрифт">${icons.aminus}</button><button class="bar-btn" id="zp" aria-label="Більший шрифт">${icons.aplus}</button>${cfg().readOnly ? "" : `<button class="bar-btn accent" id="ed" aria-label="Редагувати">${icons.edit}</button>`}`,
  });
  const authors = [s.wordsAuthor && "сл. " + s.wordsAuthor, s.musicAuthor && "муз. " + s.musicAuthor].filter(Boolean).join(" · ");
  view.innerHTML = `<article class="song"><h1>${esc(s.title)}</h1><div class="meta">${esc([s.altTitle, authors].filter(Boolean).join(" · "))}</div>
    ${(s.chunks || []).map((c) => `<div class="part" style="border-color:${colorOf(c.name)}"><div class="part-name" style="color:${colorOf(c.name)}">${esc(c.name)}</div><div class="part-text">${esc(lines(c.text))}</div></div>`).join("")}</article>`;
  toTop();
  const zoom = (d) => { const v = Math.min(34, Math.max(14, store.get("lyrics", 19) + d)); store.set("lyrics", v); document.documentElement.style.setProperty("--lyrics", v + "px"); };
  $("#zm").onclick = () => zoom(-2);
  $("#zp").onclick = () => zoom(2);
  if ($("#ed")) $("#ed").onclick = () => (location.hash = `#/b/${encodeURIComponent(name)}/s/${id}/edit`);
}

function screenEdit(name, id) {
  setTab("songs");
  let song, isNew = id === null;
  if (editing && editing.name === name && editing.song.id === (id || "")) {
    song = editing.song; // keep unsaved edits when coming back
  } else if (isNew) {
    song = { id: "", title: "", meta: "$TUNE$=\r\n", chunks: [{ name: "Куплет", text: "" }, { name: "Приспів", text: "" }] };
    editing = { name, song, base: "", isNew, dirty: false };
  } else {
    const s = state.book.songs.find((x) => x.id === id);
    if (!s) { location.replace("#/b/" + encodeURIComponent(name)); return; }
    song = JSON.parse(JSON.stringify(s));
    editing = { name, song, base: songKey(s), isNew, dirty: false };
  }
  document.body.classList.add("editing");
  const leave = async () => {
    if (editing.dirty && !(await ask("Вийти без збереження?", "Зміни в пісні буде втрачено.", "Вийти", true))) return;
    editing = null;
    history.back();
  };
  setBar(isNew ? "Нова пісня" : "Редагування", state.book.title, { back: leave });
  const names = ["Куплет", "Приспів", "Заспів", "Міст", "Вступ", "Кінцівка"];
  const render = () => {
    view.innerHTML = `<div class="form">
      <input class="title-in" id="fT" placeholder="Назва пісні" value="${esc(song.title)}">
      <label class="f">Друга назва<input id="fA" value="${esc(song.altTitle || "")}"></label>
      <label class="f">Автор слів<input id="fW" value="${esc(song.wordsAuthor || "")}"></label>
      <label class="f">Автор музики<input id="fM" value="${esc(song.musicAuthor || "")}"></label>
      ${song.chunks.map((c, i) => `<div class="card chunk" data-i="${i}" style="border-left-color:${colorOf(c.name)}">
        <div class="chunk-top"><input class="cn" value="${esc(c.name)}" placeholder="Частина">
          <button class="ibtn up" ${i === 0 ? "disabled" : ""} aria-label="Вище">${icons.up}</button>
          <button class="ibtn dn" ${i === song.chunks.length - 1 ? "disabled" : ""} aria-label="Нижче">${icons.down}</button>
          <button class="ibtn rm" aria-label="Видалити частину">${icons.del}</button></div>
        <div class="names">${names.map((n) => `<button type="button" data-n="${n}">${n}</button>`).join("")}</div>
        <textarea class="ct" placeholder="Текст…">${esc(lines(c.text))}</textarea></div>`).join("")}
      <button class="btn full" id="addC">${icons.plus}Додати частину</button>
      ${isNew ? "" : '<button class="btn danger full" id="delS">Видалити пісню</button>'}
    </div>
    <div class="editbar"><button class="btn" id="cancel">Скасувати</button><button class="btn primary" id="save">Зберегти</button></div>`;
    view.querySelectorAll("textarea").forEach(grow);
  };
  const grow = (t) => { t.style.height = "auto"; t.style.height = t.scrollHeight + 2 + "px"; };
  const dirty = () => { editing.dirty = true; };
  render();
  toTop();
  view.oninput = (e) => {
    const t = e.target;
    const map = { fT: "title", fA: "altTitle", fW: "wordsAuthor", fM: "musicAuthor" };
    if (map[t.id]) song[map[t.id]] = t.value;
    const card = t.closest(".chunk");
    if (card) {
      const c = song.chunks[+card.dataset.i];
      if (t.classList.contains("cn")) { c.name = t.value; card.style.borderLeftColor = colorOf(c.name); }
      if (t.classList.contains("ct")) { c.text = t.value; grow(t); }
    }
    dirty();
  };
  view.onclick = async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const card = b.closest(".chunk");
    const i = card ? +card.dataset.i : -1, ch = song.chunks;
    if (b.dataset.n && card) { ch[i].name = b.dataset.n; $(".cn", card).value = b.dataset.n; card.style.borderLeftColor = colorOf(b.dataset.n); dirty(); return; }
    if (b.classList.contains("up")) [ch[i - 1], ch[i]] = [ch[i], ch[i - 1]];
    else if (b.classList.contains("dn")) [ch[i + 1], ch[i]] = [ch[i], ch[i + 1]];
    else if (b.classList.contains("rm")) { if ((ch[i].text || "").trim() && !(await ask("Видалити частину?", `«${ch[i].name}» буде видалено.`, "Видалити", true))) return; ch.splice(i, 1); }
    else if (b.id === "addC") { ch.push({ name: ch.some((c) => /приспів/i.test(c.name)) ? "Куплет" : "Приспів", text: "" }); }
    else if (b.id === "cancel") return leave();
    else if (b.id === "save") return save(b);
    else if (b.id === "delS") return remove();
    else return;
    dirty(); render();
  };
  const save = async (btn) => {
    song.title = song.title.trim();
    if (!song.title) { toast("Вкажіть назву пісні", "err"); return; }
    const out = JSON.parse(JSON.stringify(song));
    out.chunks = out.chunks.filter((c) => (c.text || "").trim()).map((c) => ({ ...c, name: c.name.trim() || "Куплет", text: normText(c.text) }));
    for (const k of ["altTitle", "wordsAuthor", "musicAuthor"]) out[k] = (out[k] || "").trim();
    btn.disabled = true; btn.textContent = "Зберігаю…";
    try {
      const saved = await saveSong(name, out, editing.base);
      editing = null;
      dropBook(name); delete root.dataset.book; // reload with the saved song
      await ensureBook(name);
      toast("Збережено. На комп'ютерах пісня з'явиться після синхронізації.", "ok");
      document.body.classList.remove("editing");
      location.replace(`#/b/${encodeURIComponent(name)}/s/${saved.id}`);
    } catch (e) {
      toast(e.message, "err");
      btn.disabled = false; btn.textContent = "Зберегти";
    }
  };
  const remove = async () => {
    if (!(await ask("Видалити пісню?", `«${song.title}» буде видалено на всіх комп'ютерах.\nНомери наступних пісень зсунуться.`, "Видалити", true))) return;
    try {
      await saveSong(name, song, editing.base, true);
      editing = null; dropBook(name); delete root.dataset.book;
      document.body.classList.remove("editing");
      toast("Пісню видалено", "ok");
      location.replace("#/b/" + encodeURIComponent(name));
    } catch (e) { toast(e.message, "err"); }
  };
}

async function screenPlan() {
  setTab("plan");
  setBar("План служіння", "з комп'ютерів церкви");
  spinner();
  let xml, from = "";
  try {
    xml = await gh("/contents/plan/PlanDef.xml", { raw: true });
    await cachePut("plan", xml); setOffline(false);
    try {
      const c = (await gh("/commits?path=plan/PlanDef.xml&per_page=1"))[0];
      if (c) {
        const host = (c.commit.message.split(":")[0] || "").trim();
        const d = new Date(c.commit.author.date);
        from = `${host ? "з комп'ютера «" + host + "» · " : ""}${d.toLocaleDateString("uk-UA", { day: "numeric", month: "long" })} о ${d.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" })}`;
        store.set("planFrom", from);
      }
    } catch (_) {}
  } catch (e) {
    if (e.status === 404) { view.innerHTML = '<div class="empty"><p>План ще не синхронізовано.</p><p class="hint">Він з\'явиться, коли на комп\'ютері церкви збережуть план у VisioBible.</p></div>'; return; }
    if (isNetErr(e) && (xml = await cacheGet("plan"))) { setOffline(true); from = store.get("planFrom", ""); }
    else return errorView(e, screenPlan);
  }
  setBar("План служіння", from || "з комп'ютерів церкви");
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const part = (name) => [...doc.querySelectorAll(`Journal[Name="${name}"] > Item`)];
  const songs = part("Songs"), bible = part("Bible"), texts = part("Text");
  const preview = (t) => (t || "").replace(/\r/g, "").split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 2).join(" / ");
  const item = (icon, t, f, attrs = "") => `<div class="plan-item" ${attrs}><span class="plan-icon">${icon}</span><div style="flex:1;min-width:0"><div class="t">${esc(t)}</div>${f ? `<div class="f">${esc(f)}</div>` : ""}</div>${attrs ? icons.chev : ""}</div>`;
  let html = "";
  if (songs.length) html += `<div class="section-title">Пісні</div><div class="plan-box">${songs.map((it, k) => item(icons.music, (it.getAttribute("SongName") || "").replace(/[,.;:]+$/, ""), [it.getAttribute("TextModuleName"), preview(it.getAttribute("SongChunkText"))].filter(Boolean).join(" · "), `data-song="${k}"`)).join("")}</div>`;
  if (bible.length) html += `<div class="section-title">Біблія</div><div class="plan-box">${bible.map((it) => item(icons.book, (it.getAttribute("Reference") || "") + " " + (+it.getAttribute("Chapter") + 1) + ":" + (+it.getAttribute("Verse") + 1) + (it.getAttribute("ModuleShortName") ? " · " + it.getAttribute("ModuleShortName") : ""), it.getAttribute("Quote"))).join("")}</div>`;
  if (texts.length) html += `<div class="section-title">Тексти</div><div class="plan-box">${texts.map((it) => item(icons.text, (it.getAttribute("Reference") || "").replace(/:\s*$/, ""), (it.getAttribute("Quote") || "").replace(/ \| /g, "\n"))).join("")}</div>`;
  view.innerHTML = html
    ? html + '<p class="hint" style="margin:4px 16px 20px">План береться з комп\'ютера, де його востаннє змінили у VisioBible. VisioBible зберігає пісні, місця з Біблії й тексти трьома окремими списками.</p>'
    : '<div class="empty"><p>План порожній.</p></div>';
  planSongs = songs;
  view.querySelectorAll("[data-song]").forEach((el) => (el.onclick = () => (location.hash = "#/plan/s/" + el.dataset.song)));
}
let planSongs = [];

async function openPlanSong(it) {
  const title = it.getAttribute("SongName") || "";
  const mod = norm(it.getAttribute("TextModuleName") || "").trim();
  const t = norm(title).replace(/[,.;:!?]+$/, "").trim();
  const find = () => state.book.songs.find((x) => norm(x.title).trim().replace(/[,.;:!?]+$/, "").startsWith(t));
  let similar = null;
  for (const b of store.get("books", [])) {
    try { await ensureBook(b.name); } catch (_) { continue; }
    const same = norm(state.book.title).trim() === mod || norm(state.book.shortName).trim() === mod;
    const s = find();
    if (s && same) { location.replace(`#/b/${encodeURIComponent(b.name)}/s/${s.id}`); return; }
    if (s && !similar) similar = { name: b.name, id: s.id, book: state.book.title };
  }
  // the songbook of this plan song is not shared with the phone (e.g. "П 2000"):
  // show the part saved in the plan
  setTab("plan");
  setBar(title.replace(/[,.;:]+$/, ""), it.getAttribute("TextModuleName") || "", { back: "#/plan" });
  view.innerHTML = `<article class="song"><h1>${esc(title.replace(/[,.;:]+$/, ""))}</h1><div class="meta">${esc(it.getAttribute("TextModuleName") || "")} · у плані збережено лише цю частину</div>
    <div class="part"><div class="part-name">${esc(it.getAttribute("SongChunkName") || "")}</div><div class="part-text">${esc(lines(it.getAttribute("SongChunkText") || ""))}</div></div>
    <p class="hint">Повний текст є на комп'ютерах церкви: пісенник «${esc(it.getAttribute("TextModuleName") || "")}» не синхронізується з телефоном.</p>
    ${similar ? `<button class="btn full" id="sim">Схожа пісня є в «${esc(similar.book)}» — відкрити</button>` : ""}</article>`;
  if (similar) $("#sim").onclick = () => (location.hash = `#/b/${encodeURIComponent(similar.name)}/s/${similar.id}`);
  toTop();
}

function screenSettings() {
  setTab("settings");
  setBar("Налаштування");
  const c = cfg();
  view.innerHTML = `<div class="form">
    <div class="card"><p class="hint" style="margin:0">Застосунок працює з тим самим сховищем пісень, що й VisioSync на комп'ютерах церкви. Пісня, збережена тут, з'явиться на комп'ютерах після синхронізації.</p></div>
    <label class="f">Сховище (GitHub)<input id="sR" value="${esc(c.repo)}" autocapitalize="off" spellcheck="false"></label>
    <label class="f">Токен доступу<input id="sT" type="password" placeholder="${c.token ? "•••••• збережено" : "github_pat_…"}" autocapitalize="off" spellcheck="false"></label>
    <label class="f">Ваше ім'я (видно в історії змін)<input id="sN" value="${esc(c.name)}" placeholder="Наприклад: Микола, телефон"></label>
    <div><span class="pill ${c.token ? (c.readOnly ? "" : "ok") : "err"}" id="sP">${c.token ? (c.readOnly ? "лише перегляд" : "підключено") : "не підключено"}</span></div>
    <button class="btn primary full" id="sS">Зберегти й перевірити</button>
    <p class="hint">Токен зберігається тільки на цьому телефоні. Для тих, хто лише дивиться пісні, створіть токен з правом <b>Contents: Read-only</b>, а для тих, хто редагує, — <b>Read and write</b>.</p>
    <p class="hint">Щоб додати застосунок на головний екран: iPhone — «Поділитися» → «На початковий екран»; Android — меню ⋮ → «Додати на головний екран».</p>
    ${c.token ? '<button class="btn danger full" id="sX">Вийти (видалити токен з телефону)</button>' : ""}
  </div>`;
  $("#sS").onclick = async (e) => {
    const repo = $("#sR").value.trim(), tok = $("#sT").value.trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { toast("Сховище має виглядати як власник/назва", "err"); return; }
    const old = cfg();
    store.set("repo", repo); store.set("name", $("#sN").value.trim());
    if (tok) store.set("token", tok);
    e.target.disabled = true; e.target.textContent = "Перевіряю…";
    try {
      const info = await gh("");
      store.set("readOnly", !(info.permissions && info.permissions.push));
      dropBook(""); state.name = ""; delete root.dataset.book;
      toast("Підключено", "ok");
      location.hash = "#/";
    } catch (err) {
      if (tok) store.set("token", old.token);
      toast(err.message, "err");
      e.target.disabled = false; e.target.textContent = "Зберегти й перевірити";
    }
  };
  if ($("#sX")) $("#sX").onclick = async () => {
    if (!(await ask("Вийти?", "Токен буде видалено з цього телефону. Збережені пісні теж.", "Вийти", true))) return;
    store.set("token", ""); store.set("books", []); store.set("readOnly", false);
    try { await caches.delete("vs-data"); } catch (_) {}
    dropBook(""); state.name = ""; delete root.dataset.book;
    screenSettings();
  };
}

/* ---------------------------------------------------------------- router */

/* ---------------------------------------------------------------- layout */

// single: one screen in the whole content area (phones, and plan/settings everywhere)
function single() {
  if (root.dataset.layout !== "single") { root.innerHTML = ""; root.dataset.layout = "single"; delete root.dataset.book; }
  view = root;
  view.oninput = view.onclick = null;
}
// split (wide screens): the song list on the left, the song on the right
async function split(name, id) {
  if (root.dataset.layout !== "split") {
    root.innerHTML = '<div class="split"><section class="pane list-pane" id="listPane"></section><section class="pane detail-pane" id="detailPane"></section></div>';
    root.dataset.layout = "split";
    delete root.dataset.book;
  }
  const lp = $("#listPane");
  const showingAll = state.all && state.filter.trim();
  if (root.dataset.book !== name && !(showingAll && root.dataset.book)) {
    view = lp;
    lp.oninput = lp.onclick = null;
    await screenSongs(name, id);
    root.dataset.book = name;
  } else {
    lp.querySelectorAll("li[data-id]").forEach((li) => li.classList.toggle("active", li.dataset.id === id));
  }
  const act = lp.querySelector("li.active");
  if (act) act.scrollIntoView({ block: "nearest" });
  view = $("#detailPane");
  view.oninput = view.onclick = null;
}
function pickSong(name) {
  setBar(state.book.title || name, `${state.book.songs.length} пісень`);
  view.innerHTML = `<div class="empty pick">${icons.music}<p>Виберіть пісню зі списку ліворуч${cfg().readOnly ? "" : " або створіть нову"}.</p></div>`;
}
wideMQ.addEventListener("change", () => { document.body.classList.toggle("wide", isWide()); delete root.dataset.layout; route(); });
document.body.classList.toggle("wide", isWide());

async function route() {
  const h = location.hash.replace(/^#/, "") || "/";
  if (!h.match(/\/edit$|\/new$/)) document.body.classList.remove("editing");
  if (!cfg().token && h !== "/settings") { location.replace("#/settings"); return; }
  let m;
  try {
    const book = h.match(/^\/b\/([^/]+)(?:\/(s)\/([^/]+))?(?:\/(edit|new))?$/) || h.match(/^\/b\/([^/]+)\/(new)$/);
    if (book && isWide()) {
      const n = decodeURIComponent(book[1]);
      const id = book[2] === "s" ? book[3] : null;
      await ensureBook(n);
      await split(n, id);
      renderSide();
      if (h.endsWith("/new")) return screenEdit(n, null);
      if (h.endsWith("/edit")) return screenEdit(n, id);
      if (id) return screenSong(n, id);
      return pickSong(n);
    }
    single();
    renderSide();
    if (h === "/settings") return screenSettings();
    if (h === "/plan") return await screenPlan();
    if ((m = h.match(/^\/plan\/s\/(\d+)$/))) {
      if (!planSongs[+m[1]]) await screenPlan();
      return planSongs[+m[1]] ? await openPlanSong(planSongs[+m[1]]) : (location.hash = "#/plan");
    }
    if ((m = h.match(/^\/b\/([^/]+)\/new$/))) { const n = decodeURIComponent(m[1]); await ensureBook(n); return screenEdit(n, null); }
    if ((m = h.match(/^\/b\/([^/]+)\/s\/([^/]+)\/edit$/))) { const n = decodeURIComponent(m[1]); await ensureBook(n); return screenEdit(n, m[2]); }
    if ((m = h.match(/^\/b\/([^/]+)\/s\/([^/]+)$/))) { const n = decodeURIComponent(m[1]); await ensureBook(n); return screenSong(n, m[2]); }
    if ((m = h.match(/^\/b\/([^/]+)$/))) return await screenSongs(decodeURIComponent(m[1]));
    return await screenBooks();
  } catch (e) {
    errorView(e, route);
  }
}
window.addEventListener("hashchange", route);
window.addEventListener("beforeunload", (e) => { if (editing && editing.dirty) { e.preventDefault(); e.returnValue = ""; } });
route();

if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js");
