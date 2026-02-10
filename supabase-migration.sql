-- Table routes: stocke les parcours générés par utilisateur
create table public.routes (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  start_lat double precision not null,
  start_lng double precision not null,
  distance_m integer not null,
  steps_estimate integer not null,
  created_at timestamp with time zone default now() not null
);

-- Index pour compter rapidement les routes par utilisateur
create index idx_routes_user_id on public.routes(user_id);

-- Row Level Security
alter table public.routes enable row level security;

-- Policy: les utilisateurs ne voient que leurs propres routes
create policy "Users can view own routes"
  on public.routes for select
  using (auth.uid() = user_id);

-- Policy: les utilisateurs peuvent insérer leurs propres routes
create policy "Users can insert own routes"
  on public.routes for insert
  with check (auth.uid() = user_id);
