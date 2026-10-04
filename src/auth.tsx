/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { isSupabaseConfigured, supabase } from './lib/supabase'

type AuthState = { session: Session | null; loading: boolean; adminLoading: boolean; isAdmin: boolean }
const AuthContext = createContext<AuthState>({ session: null, loading: true, adminLoading: false, isAdmin: false })

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(isSupabaseConfigured)
  const [adminResult, setAdminResult] = useState<{ userId: string; isAdmin: boolean } | null>(null)

  useEffect(() => {
    if (!isSupabaseConfigured) return
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setLoading(false)
    })
    return () => data.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session) return

    let current = true
    void supabase.rpc('is_admin').then(({ data, error }) => {
      if (!current) return
      setAdminResult({ userId: session.user.id, isAdmin: !error && data === true })
    })
    return () => { current = false }
  }, [session])

  const roleResolved = Boolean(session && adminResult?.userId === session.user.id)
  return <AuthContext.Provider value={{
    session,
    loading,
    adminLoading: Boolean(session && !roleResolved),
    isAdmin: Boolean(roleResolved && adminResult?.isAdmin),
  }}>{children}</AuthContext.Provider>
}

export function useAuth() {
  return useContext(AuthContext)
}
