-- Migration V2: GPS Tracking + History support
-- Run this in the Supabase SQL Editor (Dashboard > SQL Editor)

ALTER TABLE public.routes ADD COLUMN IF NOT EXISTS geometry jsonb;
ALTER TABLE public.routes ADD COLUMN IF NOT EXISTS duration_s integer;
ALTER TABLE public.routes ADD COLUMN IF NOT EXISTS status text DEFAULT 'generated';
ALTER TABLE public.routes ADD COLUMN IF NOT EXISTS walked_distance_m integer;
ALTER TABLE public.routes ADD COLUMN IF NOT EXISTS walked_duration_s integer;
ALTER TABLE public.routes ADD COLUMN IF NOT EXISTS completed_at timestamptz;
