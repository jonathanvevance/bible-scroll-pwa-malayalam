import { BOOKS } from './books.js';
import { Journal } from './journal.js';

// Storage names carry an 'ml.' prefix: the English app may share this origin.
const LAST_VERSE = 'ml.lastVerseKey';
const ADVANCE_DELAY_MS = 700;
const SETTLE_DELAY_MS = 140;

// ---------- References (same packed key as the iOS app: book*1e6 + chapter*1e3 + verse) ----------

const packKey = (book, chapter, verse = 0) => book * 1_000_000 + chapter * 1_000 + verse;
const bookInfo = (order) => BOOKS[order - 1];
const chapterName = (ch) => `${bookInfo(ch.book).bsbName} ${ch.chapter}`;
const verseName = (v) => `${bookInfo(v.book).bsbName} ${v.chapter}:${v.verse}`;

function unpackKey(key) {
  const book = Math.floor(key / 1_000_000);
  const chapter = Math.floor((key % 1_000_000) / 1_000);
  const verse = key % 1_000;
  if (!bookInfo(book) || chapter < 1 || verse < 1) return null;
  return { book, chapter, verse };
}

/** [title, Bible Hub path, SVG icon paths (24×24, stroked)] */
const HUB_TOOLS = [
  ['Compare translations', (s, c, v) => `parallel/${s}/${c}-${v}.htm`,
    '<rect x="3" y="4" width="7" height="16" rx="1.5"/><rect x="14" y="4" width="7" height="16" rx="1.5"/>'],
  ['Read chapter context', (s, c) => `${s}/${c}.htm`,
    '<path d="M2 5h6a4 4 0 0 1 4 4v11a3 3 0 0 0-3-3H2z"/><path d="M22 5h-6a4 4 0 0 0-4 4v11a3 3 0 0 1 3-3h7z"/>'],
  ['Cross-references', (s, c, v) => `crossref/${s}/${c}-${v}.htm`,
    '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>'],
  ['Commentaries', (s, c, v) => `commentaries/${s}/${c}-${v}.htm`,
    '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/><path d="M9 12h7M9 16h7"/>'],
];
const hubURL = (tool, v) => `https://biblehub.com/${tool(bookInfo(v.book).slug, v.chapter, v.verse)}`;

// ---------- Bible text ----------

class Bible {
  constructor(books) {
    this.books = books;
    this.chapters = [];
    this.index = new Map();
    books.forEach((chapters, b) => chapters.forEach((_, c) => {
      const ch = { book: b + 1, chapter: c + 1, key: packKey(b + 1, c + 1) };
      this.index.set(ch.key, this.chapters.length);
      this.chapters.push(ch);
    }));
  }

  chapter(book, chapter) {
    return this.chapters[this.index.get(packKey(book, chapter))] ?? null;
  }

  verses(ch) {
    return this.books[ch.book - 1][ch.chapter - 1].map((text, i) => ({
      book: ch.book, chapter: ch.chapter, verse: i + 1, key: ch.key + i + 1, text,
    }));
  }

  after(ch) { return this.chapters[this.index.get(ch.key) + 1] ?? null; }
  before(ch) { return this.chapters[this.index.get(ch.key) - 1] ?? null; }
}

// ---------- Feed model (mirrors BibleCore's ChapterFeed) ----------
// The feed shows a window of chapters bracketed by boundary pages: the chapter being
// read plus one either side, so a boundary is never a dead end and the reader can
// swipe straight through it. Settling on a verse in another chapter recentres the
// window. A boundary's id is the same in every window that contains it.

const boundary = (before, after) => ({ type: 'boundary', id: `b${before?.key ?? 0}-${after?.key ?? 0}`, before, after });
const verseItem = (verse) => ({ type: 'verse', id: `v${verse.key}`, verse });

function itemsFor(window) {
  const items = [boundary(bible.before(window[0]), window[0])];
  for (const ch of window) {
    for (const v of bible.verses(ch)) if (v.text) items.push(verseItem(v));
    items.push(boundary(ch, bible.after(ch)));
  }
  return items;
}

const windowAround = (ch) => [bible.before(ch), ch, bible.after(ch)].filter(Boolean);

function windowAfterSettling(item) {
  if (item.type !== 'verse') return null;
  const next = windowAround(bible.chapter(item.verse.book, item.verse.chapter));
  const same = next.length === state.window.length && next.every((ch, i) => ch.key === state.window[i].key);
  return same ? null : next;
}

/** Saved verse -> its chapter and page; unknown keys fall back to Genesis 1:1. */
function startFor(key) {
  const ref = unpackKey(key);
  const chapter = (ref && bible.chapter(ref.book, ref.chapter)) ?? bible.chapters[0];
  const verses = itemsFor([chapter]).filter((i) => i.type === 'verse');
  const page = verses.find((i) => i.verse.key === key) ?? verses[0];
  return { window: windowAround(chapter), id: page.id };
}

/**
 * Where to carry on after resting on a boundary: forward to the next chapter's first
 * verse, or back to the previous chapter's last verse, depending on which side the
 * reader came from. End caps never advance.
 */
function advanceTarget(item, previousID) {
  if (item.type !== 'boundary' || !item.before || !item.after) return null;
  if (!previousID?.startsWith('v')) return null;
  const forward = Number(previousID.slice(1)) < item.after.key;
  const verses = state.items.filter((i) => i.type === 'verse');
  const target = forward
    ? verses.find((i) => i.verse.book === item.after.book && i.verse.chapter === item.after.chapter)
    : verses.findLast((i) => i.verse.book === item.before.book && i.verse.chapter === item.before.chapter);
  return target?.id ?? null;
}

// ---------- State ----------

const feed = document.getElementById('feed');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

let bible;
let journal;
const state = {
  window: [],
  items: [],
  settledID: null,
  touching: false,
  settleTimer: 0,
  advanceTimer: 0,
  glideTop: null,
  glideTimer: 0,
};

// Pages can be a fractional height; clientHeight rounds, which drifts over long chapters.
const pageHeight = () => feed.firstElementChild?.getBoundingClientRect().height || feed.clientHeight;
const currentIndex = () => Math.round(feed.scrollTop / pageHeight());
const currentItem = () => state.items[currentIndex()];
const currentVerse = () => (currentItem()?.type === 'verse' ? currentItem().verse : null);
const anySheetOpen = () => document.querySelector('dialog[open]') !== null;

// ---------- Rendering ----------

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
}

const actionsTemplate = document.getElementById('actionsTemplate');

function page(item) {
  const node = el('section', { className: `page ${item.type}` });
  node.dataset.id = item.id;
  if (item.type === 'verse') {
    const v = item.verse;
    if (v.text.length > 220) node.classList.add('long');
    if (v.text.length > 380) node.classList.add('very-long');
    node.append(el('div', { className: 'verse-body' },
      el('p', { className: 'verse-text', textContent: v.text }),
      el('p', { className: 'reference', textContent: verseName(v) })));
    const actions = actionsTemplate.content.firstElementChild.cloneNode(true);
    actions.querySelector('.action-count').textContent = journal.count(v.key) || '';
    node.append(actions);
  } else {
    node.append(el('div', { className: 'boundary-body' },
      item.before ? el('p', { className: 'end-of', textContent: `End of ${chapterName(item.before)}` }) : null,
      el('h1', { className: 'chapter-title', textContent: item.after ? chapterName(item.after) : 'The end' })));
  }
  return node;
}

/** Swap the feed's content and re-pin the same page in one synchronous step, so the
 *  change above the visible page is never painted. */
function show(window, pinID) {
  state.window = window;
  state.items = itemsFor(window);
  feed.replaceChildren(...state.items.map(page));
  const index = Math.max(0, state.items.findIndex((i) => i.id === pinID));
  feed.scrollTop = index * pageHeight();
  updateControls();
}

const chapterLabel = document.getElementById('chapterLabel');

/** Cheap enough to run on every scroll event: each part only writes when it changes. */
function updateControls() {
  const item = currentItem();
  const v = currentVerse();
  const chapter = v ?? item?.after ?? item?.before;
  const label = chapter ? chapterName(chapter) : '';
  if (chapterLabel.textContent !== label) chapterLabel.textContent = label;
  updateRail();
}

/** Refreshes the reflection counts on the rendered pages after reflections change. */
function updateActions() {
  for (const node of feed.querySelectorAll('.page.verse')) {
    const text = String(journal.count(Number(node.dataset.id.slice(1))) || '');
    const count = node.querySelector('.action-count');
    if (count.textContent !== text) count.textContent = text;
  }
  invalidateBackup();
  updateBackupReminder();
}

let toastTimer = 0;
function toast(message) {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 1600);
}

// ---------- Verse rail ----------

const rail = document.getElementById('rail');
const railTrack = document.getElementById('railTrack');
const railLabel = document.getElementById('railLabel');
const railNumber = document.getElementById('railNumber');
const railState = { chapterKey: 0, ids: [], current: -1, scrubbing: false, scrubIndex: -1 };

function updateRail() {
  const v = currentVerse();
  rail.hidden = !v;
  if (!v) return;
  const chapterKey = packKey(v.book, v.chapter);
  if (chapterKey !== railState.chapterKey) {
    railState.chapterKey = chapterKey;
    railState.ids = state.items
      .filter((i) => i.type === 'verse' && i.verse.book === v.book && i.verse.chapter === v.chapter)
      .map((i) => i.id);
    railTrack.style.gap = railState.ids.length > 80 ? '1px' : '2px';
    railTrack.replaceChildren(...railState.ids.map(() => document.createElement('span')));
    railState.current = -1;
  }
  const index = railState.ids.indexOf(`v${v.key}`);
  if (index === railState.current) return;
  railTrack.children[railState.current]?.classList.remove('current');
  railTrack.children[index]?.classList.add('current');
  railState.current = index;
  railNumber.textContent = String(v.verse);
  railNumber.style.top = `${((index + 0.5) / railState.ids.length) * 100}%`;
}

function scrubTo(clientY) {
  const box = railTrack.getBoundingClientRect();
  const n = railState.ids.length;
  const index = Math.min(n - 1, Math.max(0, Math.floor(((clientY - box.top) / box.height) * n)));
  if (index === railState.scrubIndex) return;
  railState.scrubIndex = index;
  const id = railState.ids[index];
  feed.scrollTop = state.items.findIndex((i) => i.id === id) * pageHeight();
  const v = state.items.find((i) => i.id === id).verse;
  railLabel.textContent = verseName(v);
  railLabel.style.top = `${box.top + ((index + 0.5) / n) * box.height}px`;
  railLabel.hidden = false;
  tick();
}

rail.addEventListener('pointerdown', (e) => {
  if (!railState.ids.length) return;
  // Touches are captured to the element under the finger anyway. Capturing to the rail would
  // retarget the tap's click away from the haptic switch, silencing it.
  if (e.pointerType !== 'touch') {
    try { rail.setPointerCapture(e.pointerId); } catch {}
  }
  railState.scrubbing = true;
  railState.scrubIndex = -1;
  clearTimeout(state.advanceTimer);
  endGlide();
  scrubTo(e.clientY);
});
rail.addEventListener('pointermove', (e) => { if (railState.scrubbing) scrubTo(e.clientY); });
for (const type of ['pointerup', 'pointercancel']) {
  rail.addEventListener(type, () => {
    railState.scrubbing = false;
    railLabel.hidden = true;
    settleSoon();
  });
}

/**
 * Haptics. Android has the Vibration API. iOS Safari has none, and since iOS 26.5 script can
 * no longer trigger one; the only path left is the user directly tapping a native switch,
 * which plays the system tick. So tappable elements carry an invisible
 * `<input type="checkbox" switch class="haptic">` over their whole area: one tick per tap,
 * and the click still bubbles to the element's own handler.
 */
function tick() {
  navigator.vibrate?.(8);
}
/** Gives a button made in script the haptic switch the HTML ones carry. */
function withHaptic(button) {
  button.append(el('input', { type: 'checkbox', className: 'haptic', tabIndex: -1 }));
  const input = button.lastChild;
  input.setAttribute('switch', '');
  input.setAttribute('aria-hidden', 'true');
  return button;
}
// The rail ticks from scrubTo on every verse it passes, so its switch need not add another.
document.addEventListener('click', (e) => {
  if (e.target.matches?.('input.haptic') && !e.target.closest('#rail')) tick();
}, true);

// ---------- Settling and auto-advance ----------

function settle() {
  if (state.touching || railState.scrubbing) return;
  const index = currentIndex();
  if (Math.abs(feed.scrollTop - index * pageHeight()) > 2) return; // still between pages
  const item = state.items[index];
  if (!item || item.id === state.settledID) return;

  const previousID = state.settledID;
  state.settledID = item.id;
  if (item.type === 'verse') localStorage.setItem(LAST_VERSE, String(item.verse.key));

  const next = windowAfterSettling(item);
  if (next) show(next, item.id);
  updateControls();
  scheduleAdvance(item, previousID);
}

function scheduleAdvance(item, previousID) {
  clearTimeout(state.advanceTimer);
  const target = advanceTarget(item, previousID);
  if (!target) return;
  state.advanceTimer = setTimeout(() => {
    if (state.touching || anySheetOpen() || tab !== 'bible' || currentItem()?.id !== item.id) return;
    glideTo(state.items.findIndex((i) => i.id === target));
  }, ADVANCE_DELAY_MS);
}

/**
 * Animated scroll to a page. iOS snaps a smooth programmatic scroll back to the page the
 * finger last snapped to, so snapping is switched off for the glide; if the animation is
 * dropped anyway, land on the page directly.
 */
function glideTo(index) {
  const top = index * pageHeight();
  if (reduceMotion.matches) {
    feed.scrollTop = top;
    return;
  }
  state.glideTop = top;
  feed.style.scrollSnapType = 'none';
  feed.scrollTo({ top, behavior: 'smooth' });
  clearTimeout(state.glideTimer);
  state.glideTimer = setTimeout(() => {
    if (!state.touching && Math.abs(feed.scrollTop - top) > 2) feed.scrollTop = top;
    endGlide();
  }, 900);
}

function endGlide() {
  if (state.glideTop == null) return;
  clearTimeout(state.glideTimer);
  state.glideTop = null;
  feed.style.scrollSnapType = '';
  settleSoon();
}

function settleSoon() {
  clearTimeout(state.settleTimer);
  state.settleTimer = setTimeout(settle, SETTLE_DELAY_MS);
}

feed.addEventListener('scroll', () => {
  updateControls();
  if (state.glideTop != null && Math.abs(feed.scrollTop - state.glideTop) <= 2) endGlide();
  settleSoon();
}, { passive: true });
feed.addEventListener('scrollend', () => { clearTimeout(state.settleTimer); settle(); });
feed.addEventListener('touchstart', () => {
  state.touching = true;
  clearTimeout(state.advanceTimer);
  endGlide();
}, { passive: true });
for (const type of ['touchend', 'touchcancel']) {
  feed.addEventListener(type, () => { state.touching = false; settleSoon(); }, { passive: true });
}

addEventListener('resize', () => {
  const index = state.items.findIndex((i) => i.id === state.settledID);
  if (index >= 0) feed.scrollTop = index * pageHeight();
});

function goToVerse(key) {
  const { window, id } = startFor(key);
  clearTimeout(state.advanceTimer);
  show(window, id);
  state.settledID = id;
  localStorage.setItem(LAST_VERSE, id.slice(1));
}

const jumpTo = (chapter) => fadeToVerse(chapter.key + 1);

// ---------- Verse actions ----------

/** Handlers for the buttons on each verse page, keyed by their data-action. */
const verseActions = {};
feed.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  const id = e.target.closest('.page').dataset.id;
  verseActions[action](state.items.find((i) => i.id === id).verse);
});

const verseQuote = (v) => `“${v.text}” (${verseName(v)}, Sathyavedapusthakam)`;

/** Opens the share sheet, or copies where there is none. `notify` must show above any open sheet. */
async function shareText(text, copied, notify = toast) {
  if (navigator.share) {
    try { await navigator.share({ text }); } catch { /* cancelled */ }
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    notify(copied);
  } catch {
    notify("Couldn't share");
  }
}

verseActions.share = (v) => shareText(verseQuote(v), 'Verse copied');

// ---------- Sheets ----------

const SHEET_CLOSE_MS = 260;

/** Slides the sheet away before closing it; resolves once it is gone. */
function closeSheet(dialog) {
  if (!dialog.open || dialog.classList.contains('closing')) return Promise.resolve();
  if (reduceMotion.matches) { dialog.close(); return Promise.resolve(); }
  dialog.classList.add('closing');
  return new Promise((resolve) => setTimeout(() => {
    dialog.classList.remove('closing');
    dialog.close();
    resolve();
  }, SHEET_CLOSE_MS));
}

/** Cross-fades the feed to another place instead of cutting to it. */
function fadeToVerse(key) {
  if (reduceMotion.matches || !document.startViewTransition) goToVerse(key);
  else document.startViewTransition(() => goToVerse(key));
}

/** Slides a view in from the side, like moving through a navigation stack. */
function slideIn(node, from) {
  if (reduceMotion.matches) return;
  node.animate(
    [{ opacity: 0, transform: `translateX(${from}px)` }, { opacity: 1, transform: 'none' }],
    { duration: 300, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' },
  );
}

// iOS only shows :active press states when the page listens for touches.
document.addEventListener('touchstart', () => {}, { passive: true });

for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog || e.target.closest('[data-close]')) closeSheet(dialog);
  });
  dialog.addEventListener('close', () => clearTimeout(state.advanceTimer));
  // One scroller at a time: a swipe only moves the area under the finger if that area can
  // scroll; otherwise it is swallowed, so the page behind never pans or scrolls.
  dialog.addEventListener('touchmove', (e) => {
    for (let node = e.target; node && node !== dialog; node = node.parentElement) {
      if (!node.matches('.sheet-body, textarea')) continue;
      const canScroll = node.scrollHeight > node.clientHeight + 1 && getComputedStyle(node).overflowY !== 'hidden';
      if (canScroll) return;
    }
    e.preventDefault();
  }, { passive: false });
}

// Keep sheets above the keyboard: the layout viewport does not shrink when it opens.
// Only while typing: the share sheet also shrinks the visual viewport, and iOS does not
// always report it growing back, which left sheets sized for the share sheet afterwards.
const typing = () => document.activeElement?.matches('textarea, input[type="search"]');
function trackKeyboard() {
  const root = document.documentElement;
  if (!typing()) {
    for (const name of ['--keyboard', '--viewport-height', '--viewport-top']) root.style.removeProperty(name);
    root.classList.remove('keyboard-up');
    return;
  }
  const vv = visualViewport;
  const keyboard = Math.max(0, innerHeight - vv.height - vv.offsetTop);
  root.style.setProperty('--keyboard', `${keyboard}px`);
  root.style.setProperty('--viewport-height', `${vv.height}px`);
  root.style.setProperty('--viewport-top', `${vv.offsetTop}px`);
  root.classList.toggle('keyboard-up', keyboard > 80);
}
visualViewport?.addEventListener('resize', trackKeyboard);
visualViewport?.addEventListener('scroll', trackKeyboard);
document.addEventListener('visibilitychange', trackKeyboard);

// Reflections timeline

const timeline = document.getElementById('timeline');
const composerText = document.getElementById('composerText');
let timelineVerse = null;

function stamp(comment) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZone: comment.timeZoneID,
    }).format(comment.createdAt);
  } catch {
    return new Date(comment.createdAt).toLocaleString();
  }
}

const timelineBody = document.getElementById('timelineBody');
const scrollTimelineToEnd = () => { timelineBody.scrollTop = timelineBody.scrollHeight; };
/** Brings the "New reflection" label to the top so what you type stays in view. */
const scrollToComposer = () => {
  const label = timelineBody.querySelector('.note-label');
  timelineBody.scrollTop += label.getBoundingClientRect().top - timelineBody.getBoundingClientRect().top;
};

/** Oldest first, like a journal, with the box for a new reflection after the latest. */
async function renderTimeline() {
  const comments = (await journal.comments(timelineVerse.key)).reverse();
  document.getElementById('timelineCount').textContent =
    comments.length === 0 ? '' : comments.length === 1 ? 'Reflection' : `Reflections (${comments.length})`;
  openRow = null;
  document.getElementById('timelineList').replaceChildren(...comments.map((c) => {
    const share = el('button', { className: 'swipe-share', textContent: 'Share' });
    share.addEventListener('click', () => {
      closeOpenRow();
      shareText(`${verseQuote(timelineVerse)}\n\n${c.body}`, 'Reflection copied', alert);
    });
    const edit = el('button', { className: 'swipe-edit', textContent: 'Edit' });
    edit.addEventListener('click', () => startEditing(c));
    const del = el('button', { className: 'swipe-delete', textContent: 'Delete' });
    del.addEventListener('click', async () => {
      if (!confirm('Delete this reflection?')) return closeOpenRow();
      await journal.delete(c);
      updateActions();
      renderTimeline();
    });
    const meta = c.updatedAt ? `${stamp(c)} · Edited` : stamp(c);
    const row = el('li', { className: 'swipe-row' },
      el('div', { className: 'swipe-actions' }, edit, share, del),
      el('div', { className: 'swipe-content' },
        el('p', { className: 'reflection-meta', textContent: meta }),
        el('p', { className: 'reflection-body', textContent: c.body })));
    makeSwipeable(row);
    return row;
  }));
}

// Swiping a reflection left reveals Edit, Share and Delete behind it, as in Mail. One row open at a time.
const SWIPE_ACTIONS_WIDTH = 240;
let openRow = null;

function closeOpenRow() {
  openRow?.querySelector('.swipe-content').style.removeProperty('transform');
  openRow = null;
}

function makeSwipeable(row) {
  const content = row.querySelector('.swipe-content');
  let startX, startY, base, x, mode;
  row.addEventListener('touchstart', (e) => {
    if (e.target.closest('.swipe-actions')) return;
    if (openRow && openRow !== row) closeOpenRow();
    ({ clientX: startX, clientY: startY } = e.touches[0]);
    base = openRow === row ? -SWIPE_ACTIONS_WIDTH : 0;
    x = base;
    mode = null;
  }, { passive: true });
  row.addEventListener('touchmove', (e) => {
    if (mode === undefined || mode === 'scroll') return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (!mode) {
      if (Math.hypot(dx, dy) < DRAG_PX) return;
      mode = Math.abs(dx) > Math.abs(dy) ? 'swipe' : 'scroll';
      if (mode === 'scroll') return;
      row.classList.add('dragging');
    }
    e.preventDefault();
    x = Math.min(0, base + dx);
    // Past the buttons the row resists, like a rubber band.
    if (x < -SWIPE_ACTIONS_WIDTH) x = -SWIPE_ACTIONS_WIDTH + (x + SWIPE_ACTIONS_WIDTH) / 3;
    content.style.transform = `translateX(${x}px)`;
  }, { passive: false });
  const settle = () => {
    if (mode !== 'swipe') return;
    mode = undefined;
    row.classList.remove('dragging');
    if (x < -SWIPE_ACTIONS_WIDTH / 2) {
      content.style.transform = `translateX(${-SWIPE_ACTIONS_WIDTH}px)`;
      openRow = row;
    } else {
      content.style.removeProperty('transform');
      if (openRow === row) openRow = null;
    }
  };
  row.addEventListener('touchend', settle);
  row.addEventListener('touchcancel', settle);
  content.addEventListener('click', closeOpenRow);
}

// A touch anywhere else in the sheet closes an open row.
timeline.addEventListener('touchstart', (e) => {
  if (openRow && !openRow.contains(e.target)) closeOpenRow();
}, { passive: true });

/** The reflection being edited in the writing area, or null when writing a new one. */
let editing = null;
const composerLabel = document.getElementById('composerLabel');
const composerHint = document.getElementById('composerHint');
const cancelEdit = document.getElementById('cancelEdit');

function setEditing(comment) {
  editing = comment;
  composerLabel.textContent = comment ? 'Edit reflection' : 'New reflection';
  composerHint.hidden = !!comment;
  cancelEdit.hidden = !comment;
  composerText.value = comment?.body ?? '';
  sizeComposer();
}

function startEditing(comment) {
  closeOpenRow();
  // A new reflection still in the box is saved rather than replaced. Not awaited, so the
  // keyboard can still open from this tap.
  if (!editing && composerText.value.trim()) {
    journal.add(composerText.value, timelineVerse.key).then(() => { updateActions(); renderTimeline(); });
  }
  setEditing(comment);
  composerText.focus();
}

cancelEdit.addEventListener('click', () => {
  setEditing(null);
  composerText.blur();
});

function sizeComposer() {
  composerText.style.height = 'auto';
  composerText.style.height = `${composerText.scrollHeight}px`;
}
composerText.addEventListener('input', sizeComposer);

/**
 * Saves whatever is in the writing area: as a new reflection, or as the new text of the one
 * being edited. Emptying an edit keeps the original; deleting is a separate choice.
 */
async function saveDraft() {
  const body = composerText.value.trim();
  const edited = editing;
  if (!timelineVerse || (!body && !edited)) return;
  try {
    if (!edited) await journal.add(body, timelineVerse.key);
    else if (body && body !== edited.body) await journal.update(edited, body);
    setEditing(null);
    updateActions();
    await renderTimeline();
    scrollTimelineToEnd();
  } catch (error) {
    alert(`Couldn't save: ${error?.message ?? error}`);
  }
}

// Done or a tap outside closes the sheet; neither loses the text.
timeline.addEventListener('close', saveDraft);

verseActions.reflect = (v) => {
  timelineVerse = v;
  document.getElementById('timelineTitle').textContent = verseName(timelineVerse);
  document.getElementById('timelineVerse').textContent = timelineVerse.text;
  document.getElementById('timelineCount').textContent = '';
  document.getElementById('timelineList').replaceChildren();
  setEditing(null);
  timeline.showModal();
  renderTimeline().then(scrollTimelineToEnd);
};

// While writing, the sheet fills the visible screen above the keyboard. Keyed off focus because a
// Home Screen app may shrink innerHeight along with the visual viewport, hiding the keyboard height.
let leaveWriting;
composerText.addEventListener('focus', () => {
  clearTimeout(leaveWriting);
  trackKeyboard();
  document.documentElement.classList.add('writing');
  setTimeout(() => { trackKeyboard(); scrollToComposer(); }, 350);
});
// Delayed so a tap on Done lands before the sheet shrinks back under the finger.
composerText.addEventListener('blur', () => {
  leaveWriting = setTimeout(() => {
    document.documentElement.classList.remove('writing');
    scrollTimelineToEnd();
  }, 250);
});
timeline.addEventListener('close', () => document.documentElement.classList.remove('writing'));

// Study (Bible Hub)

const study = document.getElementById('study');
const debug = location.hash.includes('debug');
document.getElementById('debugSection').hidden = !debug;

verseActions.study = (v) => {
  document.getElementById('studyTitle').textContent = verseName(v);
  document.getElementById('studyVerse').textContent = v.text;
  document.getElementById('studyLinks').replaceChildren(...HUB_TOOLS.map(([title, tool, icon]) => {
    const link = el('a', { href: hubURL(tool, v), target: '_blank', rel: 'noopener' });
    link.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>`;
    link.append(el('span', { textContent: title }));
    return el('li', {}, link);
  }));
  study.showModal();
};

document.getElementById('seedButton').addEventListener('click', async () => {
  const verses = bible.chapters.flatMap((ch) => bible.verses(ch)).filter((v) => v.text);
  const now = Date.now();
  const entries = Array.from({ length: 500 }, (_, i) => ({
    verseKey: verses[Math.floor(Math.random() * verses.length)].key,
    body: `Seeded reflection #${i + 1}.`,
    createdAt: now - Math.floor(Math.random() * 90 * 86_400_000),
  }));
  await journal.addMany(entries);
  updateActions();
  closeSheet(study);
});

document.getElementById('wipeButton').addEventListener('click', async () => {
  if (!confirm('Delete every reflection?')) return;
  await journal.deleteAll();
  updateActions();
  closeSheet(study);
});

// Jump to

const jump = document.getElementById('jump');
const bookView = document.getElementById('bookView');
const chapterView = document.getElementById('chapterView');
const jumpBack = document.getElementById('jumpBack');
const jumpTitle = document.getElementById('jumpTitle');
const bookSearch = document.getElementById('bookSearch');
const testaments = document.getElementById('testaments');
let testament = 'old';

const squash = (s) => s.toLowerCase().replaceAll(' ', '');

function renderBooks() {
  const query = squash(bookSearch.value);
  testaments.hidden = query !== '';
  for (const b of testaments.children) b.classList.toggle('selected', b.dataset.testament === testament);
  const books = query
    ? BOOKS.filter((b) => [b.name, b.bsbName, b.usfm].some((n) => squash(n).includes(query)))
    : BOOKS.filter((b) => (b.order <= 39) === (testament === 'old'));
  document.getElementById('bookList').replaceChildren(...books.map((b) => {
    const button = withHaptic(el('button', { className: 'chevron', ariaLabel: `${b.name}, ${b.chapters} chapters` },
      el('span', { className: 'book-name', textContent: b.name }),
      el('span', { className: 'chapter-count', textContent: String(b.chapters) })));
    // A beat for the pressed highlight to show before the chapters slide in.
    button.addEventListener('click', () => setTimeout(() => { showChapters(b.order); slideIn(chapterView, 40); }, 120));
    return el('li', {}, button);
  }));
}

function showBooks() {
  chapterView.hidden = true;
  bookView.hidden = false;
  jumpBack.hidden = true;
  jumpTitle.textContent = 'Books';
  renderBooks();
}
jumpBack.addEventListener('click', () => slideIn(bookView, -40));

function showChapters(order) {
  const book = bookInfo(order);
  const here = currentItem()?.verse ?? state.window[0];
  testament = order <= 39 ? 'old' : 'new';
  bookView.hidden = true;
  chapterView.hidden = false;
  jumpBack.hidden = false;
  jumpTitle.textContent = book.name;
  const grid = document.getElementById('chapterGrid');
  grid.replaceChildren(...Array.from({ length: book.chapters }, (_, i) => {
    const button = withHaptic(el('button', { textContent: String(i + 1) }));
    if (here.book === order && here.chapter === i + 1) button.classList.add('current');
    button.addEventListener('click', async () => {
      await closeSheet(jump);
      jumpTo(bible.chapter(order, i + 1));
    });
    return button;
  }));
  requestAnimationFrame(() => grid.querySelector('.current')?.scrollIntoView({ block: 'center' }));
}

testaments.addEventListener('click', (e) => {
  const t = e.target.closest('[data-testament]')?.dataset.testament;
  if (t) { testament = t; renderBooks(); }
});
bookSearch.addEventListener('input', renderBooks);
jumpBack.addEventListener('click', showBooks);

document.getElementById('jumpButton').addEventListener('click', () => {
  bookSearch.value = '';
  const here = currentItem()?.verse ?? state.window[0];
  showChapters(here.book);
  jump.showModal();
});

// Pressing in the Jump sheet: the row or cell under the finger is highlighted and the highlight
// follows a drag. Only a tap opens; once the finger moves, the gesture is a drag and the haptic
// switches are disabled for it, since a native switch would otherwise toggle (and open) on release.
const PRESSABLE = '#bookList button, #chapterGrid button';
const DRAG_PX = 10;
let press = null;
let pressed = null;

function setPressed(node) {
  if (node === pressed) return;
  pressed?.classList.remove('pressed');
  pressed = node;
  pressed?.classList.add('pressed');
}
function setSwitchesEnabled(on) {
  for (const input of jump.querySelectorAll('.haptic')) input.disabled = !on;
}

jump.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  press = { x: t.clientX, y: t.clientY, moved: false };
  setPressed(e.target.closest(PRESSABLE));
}, { passive: true });
jump.addEventListener('touchmove', (e) => {
  if (!press) return;
  const t = e.touches[0];
  if (!press.moved && Math.hypot(t.clientX - press.x, t.clientY - press.y) > DRAG_PX) {
    press.moved = true;
    setSwitchesEnabled(false);
  }
  if (press.moved) setPressed(document.elementFromPoint(t.clientX, t.clientY)?.closest(PRESSABLE) ?? null);
}, { passive: true });
for (const type of ['touchend', 'touchcancel']) {
  jump.addEventListener(type, () => {
    const drag = press?.moved;
    // A tap keeps its highlight a moment so it registers; a drag clears at once.
    setTimeout(() => setPressed(null), drag ? 0 : 160);
    if (drag) {
      // Kept until the release's click (if any) has been swallowed below.
      setTimeout(() => { setSwitchesEnabled(true); press = null; }, 400);
    } else {
      press = null;
    }
  }, { passive: true });
}
jump.addEventListener('click', (e) => {
  if (press?.moved && e.target.closest(PRESSABLE)) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

// ---------- Tabs ----------

const tabBar = document.getElementById('tabBar');
const reflectionsView = document.getElementById('reflectionsView');
const bibleView = [feed, rail, document.querySelector('.topbar')];
let tab = 'bible';

/** The Bible view is only hidden, never removed, so the feed keeps its place. */
function showTab(name) {
  if (name === tab) return;
  tab = name;
  const reading = name === 'bible';
  document.documentElement.classList.toggle('tab-reflections', !reading);
  for (const button of tabBar.querySelectorAll('[data-tab]')) {
    const selected = button.dataset.tab === name;
    button.classList.toggle('selected', selected);
    if (selected) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  for (const node of bibleView) node.inert = !reading;
  reflectionsView.hidden = reading;
  if (!reading) {
    clearTimeout(state.advanceTimer);
    endGlide();
    renderReflections();
  }
}

tabBar.addEventListener('click', (e) => {
  const name = e.target.closest('[data-tab]')?.dataset.tab;
  if (name) showTab(name);
});

// ---------- Reflections tab ----------

const FILTER = 'ml.reflectionsFilter';
const reflectionsFilter = document.getElementById('reflectionsFilter');
const reflectionsList = document.getElementById('reflectionsList');
const reflectionsEmpty = document.getElementById('reflectionsEmpty');
const PAGE_SIZE = 50;

let filter = localStorage.getItem(FILTER) ?? 'week';
if (!['today', 'week', 'month', 'all'].includes(filter)) filter = 'week';

/** The week starts on the day the phone's region uses (Sunday in the US, Monday in much of Europe). */
function weekStart(now) {
  const locale = new Intl.Locale(navigator.language);
  const firstDay = (locale.getWeekInfo?.() ?? locale.weekInfo)?.firstDay ?? 1; // 1 = Monday … 7 = Sunday
  const daysBack = (now.getDay() - (firstDay % 7) + 7) % 7;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack);
}

/** Where a filter's period starts, in ms, and what to say when it holds nothing. */
function filterRange(f) {
  const now = new Date();
  if (f === 'today') return { from: +new Date(now.getFullYear(), now.getMonth(), now.getDate()), empty: 'No reflections today' };
  if (f === 'week') return { from: +weekStart(now), empty: 'No reflections this week' };
  if (f === 'month') return { from: +new Date(now.getFullYear(), now.getMonth(), 1), empty: 'No reflections this month' };
  return { from: 0, empty: 'No reflections yet' };
}

const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const dayFormatWithYear = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
function dayName(ms) {
  const date = new Date(ms);
  return (date.getFullYear() === new Date().getFullYear() ? dayFormat : dayFormatWithYear).format(date);
}

function timeOf(comment) {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: comment.timeZoneID })
      .format(comment.createdAt);
  } catch {
    return new Date(comment.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
}

function reflectionCard(comment) {
  const v = unpackKey(comment.verseKey);
  const card = el('button', { className: 'reflection-card' },
    el('span', { className: 'reflection-top' },
      el('span', { textContent: v ? verseName(v) : '' }),
      el('span', { className: 'reflection-time', textContent: timeOf(comment) })),
    el('span', { className: 'reflection-verse', textContent: v ? bible.books[v.book - 1]?.[v.chapter - 1]?.[v.verse - 1] ?? '' : '' }),
    el('span', { className: 'reflection-text', textContent: comment.body }));
  card.dataset.key = comment.verseKey;
  return card;
}

/** The list shown so far; replaced whenever the list starts over, which cancels a load in flight. */
let listing = null;

/** Newest first, under a heading for each day, loaded a page at a time as the list scrolls. */
function renderReflections() {
  if (!journal) return;
  for (const node of reflectionsFilter.children) node.classList.toggle('selected', node.dataset.range === filter);
  listing = { ...filterRange(filter), loaded: 0, done: false, loading: false, day: null, list: null };
  reflectionsList.replaceChildren();
  reflectionsEmpty.hidden = true;
  reflectionsView.scrollTop = 0;
  loadMoreReflections();
  updateBackupReminder();
}

async function loadMoreReflections() {
  const run = listing;
  if (!run || run.loading || run.done) return;
  run.loading = true;
  const rows = await journal.page(run.from, run.loaded, PAGE_SIZE);
  if (run !== listing) return;
  run.loading = false;
  run.loaded += rows.length;
  run.done = rows.length < PAGE_SIZE;
  for (const comment of rows) {
    const name = dayName(comment.createdAt);
    if (name !== run.day) {
      run.day = name;
      run.list = el('ul', { className: 'reflection-cards' });
      reflectionsList.append(el('section', { className: 'reflection-day' },
        el('h2', { className: 'section-label', textContent: name }), run.list));
    }
    run.list.append(el('li', {}, reflectionCard(comment)));
  }
  reflectionsEmpty.textContent = run.empty;
  reflectionsEmpty.hidden = run.loaded > 0;
  loadIfNearEnd();
}

/** Keeps about a screen of cards ready below the visible ones. */
function loadIfNearEnd() {
  const v = reflectionsView;
  if (v.scrollTop + v.clientHeight > v.scrollHeight - v.clientHeight) loadMoreReflections();
}
reflectionsView.addEventListener('scroll', loadIfNearEnd, { passive: true });

function setFilter(next) {
  filter = next;
  localStorage.setItem(FILTER, next);
  renderReflections();
}

reflectionsFilter.addEventListener('click', (e) => {
  const range = e.target.closest('button[data-range]')?.dataset.range;
  if (range) setFilter(range);
});

// The filter and the backup banner scroll with the list. A native switch toggles when a drag ends
// on it, so once a touch starting on them moves, their switches are disabled: a scroll neither
// ticks nor presses.
const backupBanner = document.getElementById('backupBanner');
const scrollingControls = [reflectionsFilter, backupBanner];
let controlTouch = null;
function setControlSwitches(on) {
  for (const control of scrollingControls) {
    for (const input of control.querySelectorAll('.haptic')) input.disabled = !on;
  }
  if (on) setBackupEnabled(backupReady !== null);
}
for (const control of scrollingControls) {
  control.addEventListener('touchstart', (e) => {
    controlTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY, moved: false };
  }, { passive: true });
  control.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (controlTouch && !controlTouch.moved && Math.hypot(t.clientX - controlTouch.x, t.clientY - controlTouch.y) > DRAG_PX) {
      controlTouch.moved = true;
      setControlSwitches(false);
    }
  }, { passive: true });
  for (const type of ['touchend', 'touchcancel']) {
    control.addEventListener(type, () => {
      if (controlTouch?.moved) setTimeout(() => setControlSwitches(true), 400);
      controlTouch = null;
    }, { passive: true });
  }
}

reflectionsList.addEventListener('click', (e) => {
  const key = Number(e.target.closest('.reflection-card')?.dataset.key);
  if (!key) return;
  const go = () => { showTab('bible'); goToVerse(key); };
  if (reduceMotion.matches || !document.startViewTransition) go();
  else document.startViewTransition(go);
});

// ---------- Backup ----------
// A backup is one readable JSON file the person saves to iCloud Drive through the share sheet.
// Restoring only needs id, verseKey, body, createdAt, timeZoneID and updatedAt; the reference,
// verse text and ISO date are there so the file still makes sense without the app.

const LAST_BACKUP = 'ml.lastBackupAt';
const LAST_BACKUP_COUNT = 'ml.lastBackupCount';
const BACKUP_FORMAT = 1;
const backup = document.getElementById('backup');
const backupStatus = document.getElementById('backupStatus');
const backupNow = document.getElementById('backupNow');
const bannerBackup = document.getElementById('bannerBackup');
/**
 * Built ahead of the tap: iOS only allows sharing straight after one, with no waiting in between.
 * Any change to the reflections makes it stale (`invalidateBackup`).
 */
let backupReady = null;
let backupBuild = 0;
let backupBuilding = -1;

const reflectionTotal = () => [...journal.counts.values()].reduce((sum, n) => sum + n, 0);

async function backupFile() {
  const reflections = (await journal.allComments()).map((c) => {
    const v = unpackKey(c.verseKey);
    return {
      id: c.id,
      verseKey: c.verseKey,
      reference: v ? verseName(v) : null,
      verseText: v ? bible.books[v.book - 1]?.[v.chapter - 1]?.[v.verse - 1] ?? null : null,
      body: c.body,
      createdAt: c.createdAt,
      createdAtISO: new Date(c.createdAt).toISOString(),
      timeZoneID: c.timeZoneID,
      updatedAt: c.updatedAt ?? null,
    };
  });
  const now = new Date();
  const data = {
    app: 'Bible Scroll',
    format: BACKUP_FORMAT,
    exportedAt: now.toISOString(),
    translation: 'Sathyavedapusthakam 1910',
    count: reflections.length,
    reflections,
  };
  // One fixed name, so saving to the same folder offers to replace the last backup.
  return new File([JSON.stringify(data, null, 2)], 'Bible Scroll Malayalam backup.json', { type: 'application/json' });
}

function setBackupEnabled(on) {
  for (const button of [backupNow, bannerBackup]) {
    button.disabled = !on;
    button.querySelector('.haptic').disabled = !on;
  }
}

function invalidateBackup() {
  backupReady = null;
  shrinkAccepted = false;
  backupBuild++;
  setBackupEnabled(false);
}

/** Builds the file once per version of the reflections; the backup buttons wait for it. */
function prepareBackup() {
  if (backupReady || !reflectionTotal()) return setBackupEnabled(backupReady !== null);
  if (backupBuilding === backupBuild) return;
  const build = backupBuilding = backupBuild;
  setBackupEnabled(false);
  backupFile()
    .then((file) => {
      if (build !== backupBuild) return;
      backupReady = file;
      setBackupEnabled(true);
    })
    .catch((error) => alert(`Couldn't prepare the backup: ${error?.message ?? error}`));
}

/** "Today at 3:51 PM", "Yesterday at …", or "20 Oct 2026 at …", like Settings. */
function backupTime(ms) {
  const date = new Date(ms);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(ms).setHours(0, 0, 0, 0)) / 86_400_000);
  const day = days === 0 ? 'Today' : days === 1 ? 'Yesterday'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
  return `${day} at ${new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(date)}`;
}

function updateBackupStatus() {
  const last = Number(localStorage.getItem(LAST_BACKUP));
  const status = last ? `Last backup: ${backupTime(last)}`
    : reflectionTotal() ? 'Never backed up' : 'No reflections to back up yet';
  backupStatus.textContent = `${status}\nSave to Files, then iCloud Drive.`;
}

const help = document.getElementById('help');
document.getElementById('helpButton').addEventListener('click', () => help.showModal());

document.getElementById('backupButton').addEventListener('click', () => {
  updateBackupStatus();
  prepareBackup();
  backup.showModal();
});

function backedUp(count) {
  localStorage.setItem(LAST_BACKUP, String(Date.now()));
  localStorage.setItem(LAST_BACKUP_COUNT, String(count));
  shrinkAccepted = false;
  updateBackupStatus();
  updateBackupReminder();
  closeSheet(backup);
  toast(`Backed up ${count} reflection${count === 1 ? '' : 's'}`);
}

backupNow.addEventListener('click', shareBackup);
bannerBackup.addEventListener('click', shareBackup);

/**
 * Set once the person agrees to a backup with fewer reflections than the last one. The backup
 * replaces the previous file, so a smaller one could quietly drop reflections for good.
 */
let shrinkAccepted = false;

async function shareBackup() {
  const file = backupReady;
  if (!file) return;
  const count = reflectionTotal();
  const lastCount = Number(localStorage.getItem(LAST_BACKUP_COUNT));
  if (count < lastCount && !shrinkAccepted) {
    if (!confirm(`This backup has ${plural(count)}; your last one had ${lastCount}. Back up anyway?`)) return;
    shrinkAccepted = true;
  }
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      backedUp(count);
    } catch (error) {
      // Cancelling the share sheet is not a failure. Answering the warning can use up the tap
      // iOS requires for sharing; the next tap goes straight to the share sheet.
      if (error?.name === 'NotAllowedError') alert('Tap Back Up again to finish.');
      else if (error?.name !== 'AbortError') alert(`Couldn't back up: ${error?.message ?? error}`);
    }
    return;
  }
  const url = URL.createObjectURL(file);
  el('a', { href: url, download: file.name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  backedUp(count);
}

// Reminder: a backup is due when there are reflections newer than the last backup and that
// backup is over a week old (or there has never been one). A red dot marks the Reflections tab
// and the backup button until then; the banner can be put off for a few days.

const SNOOZED = 'ml.backupSnoozedUntil';
const DAY_MS = 86_400_000;
const backupBannerDetail = document.getElementById('backupBannerDetail');

async function backupOverdue() {
  if (!reflectionTotal()) return false;
  const last = Number(localStorage.getItem(LAST_BACKUP));
  if (!last) return true;
  if (Date.now() - last < 7 * DAY_MS) return false;
  return (await journal.page(last + 1, 0, 1)).length > 0;
}

async function updateBackupReminder() {
  const due = await backupOverdue();
  document.documentElement.classList.toggle('backup-due', due);
  backupBanner.hidden = !due || Date.now() < Number(localStorage.getItem(SNOOZED));
  if (backupBanner.hidden) return;
  const last = Number(localStorage.getItem(LAST_BACKUP));
  const days = Math.floor((Date.now() - last) / DAY_MS);
  backupBannerDetail.textContent = last ? `Your last backup was ${days} days ago.` : "You haven't backed up yet.";
  if (tab === 'reflections') prepareBackup();
}

document.getElementById('bannerLater').addEventListener('click', () => {
  localStorage.setItem(SNOOZED, String(Date.now() + 3 * DAY_MS));
  backupBanner.hidden = true;
});

// Restore: merge only. Reflections already on the phone (same id) are left as they are.

const restoreFile = document.getElementById('restoreFile');
const plural = (n) => `${n} reflection${n === 1 ? '' : 's'}`;

/** The backup's reflections, checked in full first so a bad file writes nothing. */
function readBackup(text) {
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (data?.app !== 'Bible Scroll' || !Array.isArray(data.reflections)) {
    throw new Error("This file isn't a Bible Scroll backup.");
  }
  if (!Number.isInteger(data.format) || data.format < 1) throw new Error("This file isn't a Bible Scroll backup.");
  if (data.format > BACKUP_FORMAT) throw new Error('This backup was made by a newer version of the app. Update the app, then try again.');
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return data.reflections.map((r, i) => {
    const valid = typeof r?.id === 'string' && r.id !== ''
      && Number.isInteger(r.verseKey) && unpackKey(r.verseKey) !== null
      && typeof r.body === 'string' && r.body.trim() !== ''
      && Number.isFinite(r.createdAt);
    if (!valid) throw new Error(`Reflection ${i + 1} in this backup is damaged, so nothing was restored.`);
    return {
      id: r.id,
      verseKey: r.verseKey,
      body: r.body,
      createdAt: r.createdAt,
      timeZoneID: typeof r.timeZoneID === 'string' ? r.timeZoneID : zone,
      updatedAt: Number.isFinite(r.updatedAt) ? r.updatedAt : null,
    };
  });
}

async function restoreFrom(file) {
  return journal.importMany(readBackup(await file.text()));
}

document.getElementById('restoreNow').addEventListener('click', () => restoreFile.click());

restoreFile.addEventListener('change', async () => {
  const file = restoreFile.files[0];
  restoreFile.value = ''; // picking the same file again still fires change
  if (!file) return;
  try {
    const { added, skipped } = await restoreFrom(file);
    updateActions();
    renderReflections();
    await closeSheet(backup);
    if (added === 0) toast('Everything in this backup is already here');
    else toast(`Restored ${plural(added)}${skipped ? ` (${skipped} already here)` : ''}`);
  } catch (error) {
    alert(error?.message ?? String(error));
  }
});

// ---------- Start ----------

async function start() {
  const [data, opened] = await Promise.all([
    fetch('mal1910.json').then((r) => r.json()),
    Journal.open(),
  ]);
  bible = new Bible(data.books);
  journal = opened;
  const begin = startFor(Number(localStorage.getItem(LAST_VERSE)));
  show(begin.window, begin.id);
  state.settledID = begin.id;
  document.getElementById('loading').remove();
  updateBackupReminder();

  // Ask the browser not to evict our data under storage pressure.
  navigator.storage?.persist?.();
}

// Registered before start() so a broken version can still be replaced by the next one.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');

start().catch((error) => {
  document.getElementById('loading').textContent = `Couldn't load: ${error?.message ?? error}`;
});
