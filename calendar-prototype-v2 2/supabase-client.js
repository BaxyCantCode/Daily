/* ─── Shared Supabase client + data/auth layer ──────────────────────────
   Loaded via a plain <script> tag before each page's own
   <script type="text/babel"> block — same CDN-script pattern the app
   already uses for React/ReactDOM/Babel, so this migration doesn't
   introduce a build step where none existed before.

   This file is the ONE place that talks to Supabase. Every page calls
   the `Cal.*` functions below instead of hand-rolling its own
   localStorage reads/writes — previously `saveManualEvent`, `TYPE_EMOJI`,
   `CATEGORIES`, and friends were each copy-pasted per file (see the code
   debug report from the localStorage version of this app for two real
   bugs that caused), so consolidating them here is a deliberate fix,
   not just a side effect of moving to Supabase.

   Fill in SUPABASE_URL / SUPABASE_ANON_KEY below from your own project
   (Supabase Dashboard → Project Settings → API) — see SETUP.md. The anon
   key is safe to ship in client-side code; Row Level Security (see
   sql/schema.sql) is what actually keeps one user's data private from
   another, not secrecy of this key.
   ────────────────────────────────────────────────────────────────────── */

const SUPABASE_URL = 'https://urwxxznrchguucwlwaqb.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_zSxdFLWt6z9_4nZG0uIp2w_uok_OQ6U';

// supabase-js's default session handling coordinates across browser tabs
// using the Web Locks API (navigator.locks) — on some devices (Chrome on
// Android in particular) that lock acquisition can hang forever with no
// timeout, which freezes every Cal.* call that touches auth (requireSession,
// getUser, signIn, signOut...) since they all sit behind it. This app never
// needs multi-tab session coordination, so `lock` is replaced with a no-op
// that just runs the given function immediately instead of waiting on a
// browser lock that may never become available.
// See: https://github.com/supabase/supabase-js/issues/1594
async function _noOpLock(name, acquireTimeout, fn) {
  return await fn();
}

const _sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { lock: _noOpLock },
});

const TYPE_EMOJI = { work: '🗓️', personal: '☀️', social: '☕', travel: '🚗', free: '🌿', health: '🏋️' };
const CATEGORIES = ['work', 'personal', 'social', 'travel', 'free', 'health'];

const Cal = {};

// Belt-and-suspenders on top of the noOpLock above: races any promise
// against a plain timer so a page can never get stuck on its loading
// screen forever, no matter what causes a hang (a lock, a dropped
// connection, anything) — it fails loud instead of failing silent.
function _withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timed out after ' + ms + 'ms')), ms)),
  ]);
}

/* ── Auth ────────────────────────────────────────────────────────────── */

// Call once, at the top of each page (before rendering real content).
// Redirects to login.html and returns null if there's no signed-in user;
// otherwise returns the Supabase session. Every page except login.html
// itself should gate its data-fetching useEffect on this.
Cal.requireSession = async function () {
  let session;
  try {
    ({ data: { session } } = await _withTimeout(_sb.auth.getSession(), 8000, 'getSession'));
  } catch (e) {
    console.error('requireSession:', e.message);
    window.location.href = 'login.html';
    return null;
  }
  if (!session) {
    window.location.href = 'login.html';
    return null;
  }
  return session;
};

Cal.getUser = async function () {
  try {
    const { data: { user } } = await _withTimeout(_sb.auth.getUser(), 8000, 'getUser');
    return user;
  } catch (e) {
    console.error('getUser:', e.message);
    return null;
  }
};

Cal.signOut = async function () {
  await _sb.auth.signOut();
  window.location.href = 'login.html';
};

// Used only by login.html. Returns { error } (error is null on success),
// matching supabase-js's own return shape so the caller can just check
// `.error` without needing to know anything about the client internals.
Cal.signIn = function (email, password) {
  return _sb.auth.signInWithPassword({ email, password });
};
Cal.signUp = function (email, password) {
  return _sb.auth.signUp({ email, password });
};

// login.html-only: if there's already a live session, skip the form and
// go straight to the app instead of making a signed-in user re-enter
// credentials.
Cal.redirectIfSignedIn = async function () {
  try {
    const { data: { session } } = await _withTimeout(_sb.auth.getSession(), 8000, 'getSession');
    if (session) window.location.href = 'index.html';
  } catch (e) {
    console.error('redirectIfSignedIn:', e.message);
    // Fall through and just show the login form rather than get stuck.
  }
};

/* ── Row <-> app-object field mapping ───────────────────────────────────
   The app's existing JS objects use start/end/eventId (camelCase, carried
   over from the original localStorage version); Postgres columns are
   snake_case. Centralizing the translation here means every page keeps
   working with the exact same event/task shape it already used. */
function rowToEvent(row) {
  return {
    id: row.id, type: row.type, title: row.title, sub: row.sub || '',
    date: row.date, start: row.start_time, end: row.end_time,
    tag: row.tag, emoji: row.emoji || TYPE_EMOJI[row.type] || '✦',
    source: row.source,
  };
}
function eventToRow(ev) {
  return {
    id: ev.id, type: ev.type, title: ev.title, sub: ev.sub || '',
    date: ev.date, start_time: ev.start, end_time: ev.end,
    tag: ev.tag, emoji: ev.emoji || TYPE_EMOJI[ev.type] || '✦',
    source: ev.source || 'bot',
  };
}
function rowToTask(row) {
  return { id: row.id, eventId: row.event_id, text: row.text, checked: !!row.checked, createdAt: row.created_at };
}

/* ── Events ──────────────────────────────────────────────────────────── */

Cal.loadEvents = async function () {
  const { data, error } = await _sb.from('events').select('*').order('date').order('start_time');
  if (error) { console.error('loadEvents:', error.message); return []; }
  return (data || []).map(rowToEvent);
}

// Bulk-inserts new events, skipping any that already exist by content
// (same title+date+start+end) — mirrors the original app's
// saveEventsToSchedule() dedup guard, since the bot always mints a fresh
// id per call and duplicate-content is what actually needs catching (e.g.
// re-clicking an old "Add event" button after a reload). Returns how many
// were actually inserted, same as the boolean the old function returned,
// but as a count so callers can build an accurate confirmation message.
Cal.saveEvents = async function (events) {
  if (!events || !events.length) return 0;
  const existing = await Cal.loadEvents();
  const isDup = (ev) => existing.some(e => e.title === ev.title && e.date === ev.date && e.start === ev.start && e.end === ev.end);
  const fresh = events.filter(ev => !isDup(ev));
  if (!fresh.length) return 0;
  const { error } = await _sb.from('events').insert(fresh.map(eventToRow));
  if (error) { console.error('saveEvents:', error.message); return 0; }
  return fresh.length;
};

// Single-event upsert — used by the manual create/edit modal (EventModal),
// which already knows the exact id to create or overwrite.
Cal.saveEvent = async function (event) {
  const { error } = await _sb.from('events').upsert(eventToRow(event));
  if (error) console.error('saveEvent:', error.message);
};

// Deletes events by id. Their tasks go with them automatically via the
// `tasks.event_id references events(id) on delete cascade` in the schema
// — the original app had to manually filter cal_action_bot_tasks by
// eventId on every removal; that whole step is now the database's job.
Cal.deleteEvents = async function (ids) {
  if (!ids || !ids.length) return;
  const { error } = await _sb.from('events').delete().in('id', ids);
  if (error) console.error('deleteEvents:', error.message);
};

/* ── Tasks ───────────────────────────────────────────────────────────── */

Cal.loadTasks = async function () {
  const { data, error } = await _sb.from('tasks').select('*').order('created_at');
  if (error) { console.error('loadTasks:', error.message); return []; }
  return (data || []).map(rowToTask);
};

// Replaces the full task list for one event (used by EventModal's Action
// items textarea, on both create and edit). Deleting-then-reinserting
// means every fresh task gets checked: false and a brand-new row — there
// is no positional id to accidentally collide with a stale checked-state
// entry, which is what the localStorage version's bug (see the debug
// report) came from. Cascade delete + a real per-row `checked` column
// makes that bug class structurally impossible now, not just patched.
Cal.saveTasksForEvent = async function (eventId, texts) {
  await _sb.from('tasks').delete().eq('event_id', eventId);
  const clean = (texts || []).filter(Boolean);
  if (!clean.length) return;
  const rows = clean.map((text, i) => ({ id: 'bt_' + eventId + '_' + i, event_id: eventId, text, checked: false }));
  const { error } = await _sb.from('tasks').insert(rows);
  if (error) console.error('saveTasksForEvent:', error.message);
};

// Appends inline tasks carried on one or more freshly-created bot events
// (ADD_EVENT's own "task1; task2" field) — additive, not a replace, since
// these are brand-new events with no prior tasks to clear.
Cal.saveEventTasks = async function (events) {
  const rows = [];
  (events || []).forEach(ev => {
    (ev.tasks || []).forEach((text, i) => {
      if (text) rows.push({ id: 'bt_' + ev.id + '_' + i, event_id: ev.id, text, checked: false });
    });
  });
  if (!rows.length) return;
  const { error } = await _sb.from('tasks').insert(rows);
  if (error) console.error('saveEventTasks:', error.message);
};

// Appends loose bulleted items from a chat reply ("Save to action page"),
// deduped against existing text for the same event (or the same
// eventId: null "From Assistant" bucket) — same rule the original
// saveToActionPage() used.
Cal.addTasks = async function (eventId, texts) {
  const clean = (texts || []).filter(Boolean);
  if (!clean.length) return false;
  const existing = (await Cal.loadTasks()).filter(t => t.eventId === eventId).map(t => t.text);
  const fresh = clean.filter(text => existing.indexOf(text) === -1);
  if (!fresh.length) return false;
  const now = Date.now();
  const rows = fresh.map((text, i) => ({ id: 'bt_' + now + '_' + i, event_id: eventId, text, checked: false }));
  const { error } = await _sb.from('tasks').insert(rows);
  if (error) { console.error('addTasks:', error.message); return false; }
  return true;
};

Cal.setTaskChecked = async function (taskId, checked) {
  const { error } = await _sb.from('tasks').update({ checked }).eq('id', taskId);
  if (error) console.error('setTaskChecked:', error.message);
};

Cal.deleteTask = async function (taskId) {
  const { error } = await _sb.from('tasks').delete().eq('id', taskId);
  if (error) console.error('deleteTask:', error.message);
};

/* ── Combined helper used by EventModal (create/edit form) ─────────────
   Mirrors the original localStorage version's single saveManualEvent()
   function, so the modal's own code barely changes: build the event
   object, upsert it, replace its task list. The only real difference
   from the caller's point of view is that this now returns a Promise. */
Cal.saveManualEvent = async function (form, existingId) {
  const id = existingId || ('manual_' + Date.now() + '_0');
  const type = form.type;
  const event = {
    id, type,
    emoji: TYPE_EMOJI[type] || '✦',
    title: form.title.trim(),
    sub: form.sub.trim(),
    date: form.date,
    start: form.start,
    end: form.end,
    tag: type.charAt(0).toUpperCase() + type.slice(1),
    source: 'manual',
  };
  await Cal.saveEvent(event);
  await Cal.saveTasksForEvent(id, form.tasks);
  return event;
};
