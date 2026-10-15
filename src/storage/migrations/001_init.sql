-- GitHub Merge Guardian: initial schema.
-- All tables enable row level security with NO policies, so the Supabase anon/authenticated keys
-- can read nothing. The app connects with a server-side DATABASE_URL (table owner), which bypasses RLS.

create table if not exists webhook_deliveries (
  delivery_id text primary key,
  event       text not null,
  received_at timestamptz not null default now()
);

create table if not exists installations (
  id            bigint primary key,
  account_login text not null,
  account_type  text not null,
  suspended     boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists repositories (
  id              bigint primary key,
  installation_id bigint not null references installations(id) on delete cascade,
  full_name       text not null unique,
  default_branch  text not null default 'main',
  enabled         boolean not null default true,
  created_at      timestamptz not null default now()
);
create index if not exists repositories_installation_idx on repositories(installation_id);

create table if not exists analysis_jobs (
  id               uuid primary key default gen_random_uuid(),
  idempotency_key  text not null unique,
  repo_full_name   text not null,
  installation_id  bigint not null,
  pr_number        integer not null,
  base_sha         text not null,
  head_sha         text not null,
  candidate_sha    text,
  trigger          text not null,
  status           text not null check (status in ('queued','running','succeeded','failed','stale','cancelled')),
  attempt          integer not null default 0,
  max_attempts     integer not null default 3,
  decision         text,
  error            text,
  result           jsonb,
  check_run_id     bigint,
  report_comment_id bigint,
  delivery_id      text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  started_at       timestamptz,
  completed_at     timestamptz
);
create index if not exists analysis_jobs_repo_pr_idx on analysis_jobs(repo_full_name, pr_number, created_at desc);
create index if not exists analysis_jobs_status_idx on analysis_jobs(status);

create table if not exists findings (
  job_id     uuid not null references analysis_jobs(id) on delete cascade,
  finding_id text not null,
  rule_id    text not null,
  severity   text not null,
  data       jsonb not null,
  primary key (job_id, finding_id)
);

create table if not exists pr_state (
  repo_full_name  text not null,
  pr_number       integer not null,
  latest_head_sha text not null,
  latest_job_id   uuid,
  updated_at      timestamptz not null default now(),
  primary key (repo_full_name, pr_number)
);

create table if not exists audit_log (
  id             bigserial primary key,
  at             timestamptz not null default now(),
  actor          text not null,
  action         text not null,
  repo_full_name text,
  pr_number      integer,
  head_sha       text,
  job_id         uuid,
  details        jsonb
);
create index if not exists audit_log_repo_pr_idx on audit_log(repo_full_name, pr_number, at desc);

create table if not exists repair_sessions (
  id               uuid primary key default gen_random_uuid(),
  repo_full_name   text not null,
  pr_number        integer not null,
  finding_id       text not null,
  source_head_sha  text not null,
  branch           text not null,
  status           text not null,
  attempts         integer not null default 0,
  requested_by     text not null,
  repair_pr_number integer,
  result           jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table webhook_deliveries enable row level security;
alter table installations      enable row level security;
alter table repositories       enable row level security;
alter table analysis_jobs      enable row level security;
alter table findings           enable row level security;
alter table pr_state           enable row level security;
alter table audit_log          enable row level security;
alter table repair_sessions    enable row level security;
