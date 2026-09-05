import { supabase } from './supabase'
import { getInitData } from './telegram'

export interface AuthResult {
  isAdmin: boolean
}

export async function authenticate(): Promise<AuthResult> {
  const initData = getInitData()
  if (!initData) {
    return { isAdmin: false }
  }

  // Reuse the persisted session when there is one. Minting a fresh anonymous
  // user on every page load would grow the auth user table without bound and
  // burn through the free tier's MAU allowance.
  const { data: existingSession } = await supabase.auth.getSession()
  if (!existingSession.session) {
    const { error: signInError } = await supabase.auth.signInAnonymously()
    if (signInError) {
      console.error('anonymous sign-in failed', signInError)
      return { isAdmin: false }
    }
  }

  // No userId in the body: telegram-auth derives the caller's identity from
  // the Authorization header supabase-js attaches automatically from the
  // session just created above — a caller can never assert admin for an
  // account that isn't its own.
  const { data, error } = await supabase.functions.invoke('telegram-auth', {
    body: { initData },
  })

  if (error || !data) {
    console.error('telegram-auth failed', error)
    return { isAdmin: false }
  }

  if (data.isAdmin) {
    await supabase.auth.refreshSession()
  }

  return { isAdmin: Boolean(data.isAdmin) }
}
