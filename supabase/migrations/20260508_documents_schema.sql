-- supabase/migrations/20260508_documents_schema.sql

-- pgvector ------------------------------------------------------------------
create extension if not exists vector with schema extensions;

-- documents -----------------------------------------------------------------
create table public.documents (
  id              uuid primary key default public.uuid_generate_v7(),
  thread_id       uuid not null references public.threads(id) on delete cascade,
  user_id         uuid not null references auth.users(id)    on delete cascade,
  name            text not null,
  mime            text not null,
  byte_size       bigint not null,
  kind            text not null check (kind in ('pdf','docx','md','txt')),
  storage_path    text not null,
  status          text not null default 'processing'
                  check (status in ('processing','ready','failed')),
  error_code      text,
  error_message   text,
  token_count     int,
  chunk_count     int,
  created_at      timestamptz not null default now(),
  ready_at        timestamptz,
  unique (thread_id, name)
);
create index documents_thread_id_status_idx on public.documents (thread_id, status);

-- chunks --------------------------------------------------------------------
create table public.chunks (
  id              uuid primary key default public.uuid_generate_v7(),
  document_id     uuid not null references public.documents(id) on delete cascade,
  thread_id       uuid not null references public.threads(id)   on delete cascade,
  chunk_index     int  not null,
  content         text not null,
  token_count     int  not null,
  embedding       extensions.vector(1536) not null,
  embedding_model text not null,
  fts             tsvector generated always as (to_tsvector('english', content)) stored,
  created_at      timestamptz not null default now(),
  unique (document_id, chunk_index)
);
create index chunks_thread_id_idx       on public.chunks (thread_id);
create index chunks_embedding_model_idx on public.chunks (embedding_model);
create index chunks_fts_gin             on public.chunks using gin (fts);
create index chunks_embedding_hnsw      on public.chunks
  using hnsw (embedding extensions.vector_cosine_ops);

-- messages.parts ------------------------------------------------------------
alter table public.messages add column parts jsonb;

-- RLS -----------------------------------------------------------------------
alter table public.documents enable row level security;
alter table public.chunks    enable row level security;

create policy "documents_select_own" on public.documents
  for select using (user_id = (select auth.uid()));
create policy "documents_insert_own" on public.documents
  for insert with check (user_id = (select auth.uid()));
create policy "documents_update_own" on public.documents
  for update using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "documents_delete_own" on public.documents
  for delete using (user_id = (select auth.uid()));

create policy "chunks_select_own" on public.chunks
  for select using (
    exists (select 1 from public.documents d
            where d.id = chunks.document_id and d.user_id = (select auth.uid()))
  );

-- Realtime publication: chip rail subscribes to INSERT/UPDATE on documents.
alter publication supabase_realtime add table public.documents;

-- Storage bucket ------------------------------------------------------------
insert into storage.buckets (id, name, public)
  values ('documents', 'documents', false)
  on conflict (id) do nothing;

create policy "documents_storage_select_own" on storage.objects
  for select using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
-- Inserts/updates/deletes go through service role — no client-side write policy.
