import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
const publicKey = publishableKey || anonKey

export const isSupabaseConfigured = Boolean(url && publicKey)

export const supabase = isSupabaseConfigured
  ? createClient(url!, publicKey!, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null

export type Profile = {
  id: string
  full_name: string
  role: 'admin' | 'worker'
  is_active: boolean
}

export type AttendanceRecord = {
  id: string
  worker_id: string
  work_date: string
  check_in_at: string | null
  check_out_at: string | null
  worker?: { full_name: string } | null
}

export type SyncLog = {
  attendance_id: string
  status: 'pending' | 'processing' | 'synced' | 'error'
  error: string | null
  intentos: number
  updated_at: string
}
