create table moxie_trend_candidates (
  id bigserial primary key,
  tool_url text not null unique,
  tool_domain text not null,
  tool_name_hint text,
  occurrence_count int default 1,
  first_seen_at timestamptz default now(),
  last_seen_at timestamptz default now(),
  status text default 'pending',
  promoted_product_id bigint references moxie_products(id) on delete set null,
  promoted_at timestamptz,
  dismissed_reason text,
  notes text,
  created_at timestamptz default now()
);
create index moxie_trend_status_idx on moxie_trend_candidates (status, occurrence_count desc);

create table moxie_trend_sources (
  id bigserial primary key,
  candidate_id bigint references moxie_trend_candidates(id) on delete cascade not null,
  source_site text not null,
  source_url text,
  source_title text,
  seen_at timestamptz default now(),
  scan_run_id text,
  unique (candidate_id, source_site)
);
create index moxie_trend_sources_cand_idx on moxie_trend_sources (candidate_id);

create table moxie_trend_scan_runs (
  id text primary key,
  started_at timestamptz default now(),
  finished_at timestamptz,
  total_sources_tried int default 0,
  total_sources_ok int default 0,
  total_items_found int default 0,
  total_new_candidates int default 0,
  source_errors jsonb
);

create or replace function moxie_recount_trend()
returns trigger as $$
begin
  update moxie_trend_candidates
    set occurrence_count = (select count(*) from moxie_trend_sources where candidate_id = coalesce(new.candidate_id, old.candidate_id)),
        last_seen_at = greatest(last_seen_at, now())
    where id = coalesce(new.candidate_id, old.candidate_id);
  return null;
end;
$$ language plpgsql;

create trigger moxie_trend_sources_after_change
after insert or delete on moxie_trend_sources
for each row execute function moxie_recount_trend();

alter table moxie_trend_candidates  enable row level security;
alter table moxie_trend_sources     enable row level security;
alter table moxie_trend_scan_runs   enable row level security;

create policy "moxie_trend_cands_admin" on moxie_trend_candidates for all using (moxie_is_admin()) with check (moxie_is_admin());
create policy "moxie_trend_sources_admin" on moxie_trend_sources for all using (moxie_is_admin()) with check (moxie_is_admin());
create policy "moxie_trend_runs_admin" on moxie_trend_scan_runs for all using (moxie_is_admin()) with check (moxie_is_admin());
