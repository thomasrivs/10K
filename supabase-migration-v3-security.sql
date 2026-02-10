-- Migration v3: Security - RLS UPDATE policy
-- Execute in Supabase Dashboard > SQL Editor

-- Allow users to update only their own routes
CREATE POLICY "Users can update own routes"
  ON public.routes FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
