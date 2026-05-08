-- threads --------------------------------------------------------------------

create table public.threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index threads_user_id_updated_at_idx
  on public.threads (user_id, updated_at desc);

-- messages -------------------------------------------------------------------

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null default '',
  superseded_at timestamptz,
  superseded_by uuid references public.messages(id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  -- telemetry (assistant rows)
  inngest_run_id text,
  model text,
  finish_reason text,
  input_tokens int,
  output_tokens int,
  latency_ms int
);

create index messages_thread_id_created_at_active_idx
  on public.messages (thread_id, created_at)
  where superseded_at is null;

create index messages_inngest_run_id_idx
  on public.messages (inngest_run_id);

-- triggers: bump threads.updated_at on message insert ------------------------

create or replace function public.touch_thread_on_message_insert()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  update public.threads set updated_at = now() where id = new.thread_id;
  return new;
end;
$$;

create trigger messages_touch_thread
  after insert on public.messages
  for each row execute function public.touch_thread_on_message_insert();

create or replace function public.touch_threads_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger threads_touch_updated_at
  before update on public.threads
  for each row execute function public.touch_threads_updated_at();

-- RLS ------------------------------------------------------------------------

alter table public.threads enable row level security;
alter table public.messages enable row level security;

-- threads policies
create policy "threads_select_own" on public.threads
  for select using (user_id = (select auth.uid()));
create policy "threads_insert_own" on public.threads
  for insert with check (user_id = (select auth.uid()));
create policy "threads_update_own" on public.threads
  for update using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "threads_delete_own" on public.threads
  for delete using (user_id = (select auth.uid()));

-- messages policies (ownership via parent thread)
create policy "messages_select_own" on public.messages
  for select using (
    exists (
      select 1 from public.threads t
      where t.id = messages.thread_id and t.user_id = (select auth.uid())
    )
  );
create policy "messages_insert_own" on public.messages
  for insert with check (
    exists (
      select 1 from public.threads t
      where t.id = messages.thread_id and t.user_id = (select auth.uid())
    )
  );
create policy "messages_update_own" on public.messages
  for update using (
    exists (
      select 1 from public.threads t
      where t.id = messages.thread_id and t.user_id = (select auth.uid())
    )
  );
create policy "messages_delete_own" on public.messages
  for delete using (
    exists (
      select 1 from public.threads t
      where t.id = messages.thread_id and t.user_id = (select auth.uid())
    )
  );
