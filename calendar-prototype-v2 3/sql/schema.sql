-- Calendar Prototype — Supabase schema
-- Run this once in your Supabase project's SQL Editor (Dashboard → SQL Editor → New query).
--
-- Replaces localStorage['cal_bot_events'] / localStorage['cal_action_bot_tasks']
-- with two real tables. Row Level Security means every query the browser
-- makes (via the public anon key) is automatically scoped to the signed-in
-- user — there is no way for one account to read or write another's rows,
-- even though the anon key itself is not a secret.
--
-- Ids are kept as client-generated text (e.g. 'manual_1723..._0',
-- 'bot_1723..._2'), matching the app's existing id scheme, rather than
-- switching to database-generated uuids — this keeps the diff against the
-- original localStorage-based code as small as possible.

-- ── events ──────────────────────────────────────────────────────────────
create table if not exists public.events (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  type        text not null check (type in ('work','personal','social','travel','free','health')),
  title       text not null,
  sub         text default '',
  date        date not null,
  start_time  text not null,  -- 'HH:MM', kept as text to match the app's existing string time-math helpers
  end_time    text not null,
  tag         text not null,
  emoji       text,
  source      text not null default 'bot',  -- 'bot' | 'manual' — mirrors the app's existing source flag
  created_at  timestamptz not null default now()
);

create index if not exists events_user_date_idx on public.events (user_id, date, start_time);

alter table public.events enable row level security;

create policy "events: select own rows"
  on public.events for select
  using (user_id = auth.uid());

create policy "events: insert own rows"
  on public.events for insert
  with check (user_id = auth.uid());

create policy "events: update own rows"
  on public.events for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "events: delete own rows"
  on public.events for delete
  using (user_id = auth.uid());

-- ── tasks ───────────────────────────────────────────────────────────────
-- One row per action-item checkbox. event_id is nullable — a task with no
-- event_id is the same "unlinked, lands on the From Assistant card" case
-- the original app modeled as eventId: null.
--
-- `checked` lives on the row itself now, not in a separate flat map keyed
-- by a positional id (localStorage['cal_action_checked'] in the original
-- app) — that positional-id scheme is what caused the "editing an event's
-- task list can mark an unrelated new task as already done" bug fixed in
-- the debug report. A real per-row id + a real foreign key with
-- on delete cascade makes that whole bug class structurally impossible:
-- deleting/replacing an event's tasks deletes their checked-state with them.
create table if not exists public.tasks (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  event_id    text references public.events(id) on delete cascade,
  text        text not null,
  checked     boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists tasks_user_event_idx on public.tasks (user_id, event_id);

alter table public.tasks enable row level security;

create policy "tasks: select own rows"
  on public.tasks for select
  using (user_id = auth.uid());

create policy "tasks: insert own rows"
  on public.tasks for insert
  with check (user_id = auth.uid());

create policy "tasks: update own rows"
  on public.tasks for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "tasks: delete own rows"
  on public.tasks for delete
  using (user_id = auth.uid());

-- ── profiles ────────────────────────────────────────────────────────────
-- One row per real signed-up user, auto-created the moment someone confirms
-- a Supabase Auth account (see trigger below). This is what replaces the
-- prototype's single hardcoded "Benny" persona: instead of every page and
-- the assistant's own system prompt assuming one fixed name, each signed-in
-- user gets their own row here and the app/assistant address them by it.
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text not null default '',
  created_at    timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles: select own row"
  on public.profiles for select
  using (id = auth.uid());

create policy "profiles: update own row"
  on public.profiles for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- No insert/delete policy for regular users — rows are created exclusively
-- by the trigger below (which runs as the table owner, bypassing RLS) and
-- removed automatically via the auth.users cascade when an account is
-- deleted. Users only ever update their own display_name from here on.

-- ── auto-create a profile row on signup ────────────────────────────────
-- login.html's signup form passes the chosen name as auth signup metadata
-- (`options: { data: { display_name } }`), which Supabase stores on
-- auth.users.raw_user_meta_data. This trigger copies it into profiles the
-- moment the auth user row is created, so the app never has to remember to
-- do that itself (and it still works for users created any other way, e.g.
-- directly in the Supabase dashboard — they just get an empty display_name
-- until they set one).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', ''));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── Not migrated (deliberate scope decision — see SETUP.md) ─────────────
-- Chat history (localStorage['cal_bot_history']), the voice-reply mute
-- toggle, and the light/dark theme preference all stay in localStorage,
-- per-device, for now. They're personal UI state rather than calendar
-- data, and none of them need to follow you across devices the way events
-- and to-dos do. Adding a `messages` table later, following the exact same
-- pattern as `events`/`tasks` above, is a small follow-up if you want chat
-- history to sync too.
