import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Env is injected by Vite. Both are optional so the app still builds/runs before
// a Supabase project is connected — the storefront then falls back to its bundled
// catalog and the admin shows a "connect Supabase" setup notice.
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(url && anonKey);

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url as string, anonKey as string, {
      auth: { persistSession: true, autoRefreshToken: true },
    })
  : null;

// Narrowing helper for call sites that must have a live client.
export function requireSupabase(): SupabaseClient {
  if (!supabase) {
    throw new Error('Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
  }
  return supabase;
}
