create table proposals (
  id uuid primary key,
  title text not null,
  status text not null default 'draft',
  created_at timestamptz not null default now()
);
