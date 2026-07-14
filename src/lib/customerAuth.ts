import { useEffect, useState } from 'react';
import { supabase } from './supabase';

// Customer accounts — passwordless email-code sign-in (Supabase Auth OTP).
// The auth user id is the customer's durable identity; the session persists
// in localStorage, so returning visitors are already signed in. After a
// sign-in, claimAndFetch() attaches this device's guest orders (token claim)
// plus every order placed with the verified email (email claim), then returns
// the account's full order list as tracking stubs.

export type CustomerSession = { userId: string; email: string } | null;

export function useCustomer(): CustomerSession {
  const [session, setSession] = useState<CustomerSession>(null);
  useEffect(() => {
    const sb = supabase;
    if (!sb) return;
    const apply = (s: { user?: { id: string; email?: string } } | null) =>
      setSession(s?.user ? { userId: s.user.id, email: s.user.email ?? '' } : null);
    sb.auth.getSession().then(({ data }) => apply(data.session));
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => apply(s));
    return () => sub.subscription.unsubscribe();
  }, []);
  return session;
}

// Sends the 6-digit code (creates the account on first use).
export async function sendCode(email: string): Promise<void> {
  if (!supabase) throw new Error('Not available right now.');
  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim(),
    options: { shouldCreateUser: true },
  });
  if (error) throw new Error(error.message);
}

export async function verifyCode(email: string, code: string): Promise<void> {
  if (!supabase) throw new Error('Not available right now.');
  const { error } = await supabase.auth.verifyOtp({
    email: email.trim(),
    token: code.trim(),
    type: 'email',
  });
  if (error) throw new Error(error.message);
}

export async function customerSignOut(): Promise<void> {
  await supabase?.auth.signOut();
}

// Claim guest orders for the signed-in account, then return the account's
// orders in the same stub shape the Telegram merge uses.
export async function claimAndFetch(
  stubs: { id: string; token: string }[],
): Promise<{ id: string; human_id: string; token: string; total: number; placed_at: string; address: string | null }[]> {
  if (!supabase) return [];
  await supabase.rpc('claim_my_orders', {
    p_stubs: stubs.map(s => ({ id: s.id, token: s.token })),
  });
  const { data } = await supabase.rpc('get_my_orders');
  return (data as any[] | null) ?? [];
}
