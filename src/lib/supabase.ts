import { createClient } from '@supabase/supabase-js'

import type { Database } from './database.types'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

export const supabaseUrl = url ?? 'https://configuration-required.invalid'
export const supabasePublishableKey = key ?? 'configuration-required'

export const isSupabaseConfigured = Boolean(url && key && !url.includes('your-project'))
export const emailDeliveryEnabled = import.meta.env.VITE_EMAIL_DELIVERY_ENABLED === 'true'

// Typed against the generated schema so a column rename or a missing table is a
// compile error rather than a runtime surprise. Only browser-safe values reach
// this client; the service-role key is never imported into the frontend.
export const supabase = createClient<Database>(
  supabaseUrl,
  supabasePublishableKey,
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } },
)
