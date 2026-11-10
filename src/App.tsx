import { useCallback, useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Check,
  CheckCircle2,
  ExternalLink,
  Clock3,
  Eye,
  EyeOff,
  History as HistoryIcon,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react'
import {
  isSupabaseConfigured,
  supabase,
  type AttendanceRecord,
  type Profile,
  type SyncLog,
} from './lib/supabase'

type QrSession = { token: string; access_code: string; expires_at: string }
type Notice = { tone: 'success' | 'error' | 'info'; text: string }

const PERU_ZONE = 'America/Lima'
const GOOGLE_SHEETS_URL = 'https://docs.google.com/spreadsheets/d/1qtxU2ZZEraO4h07jq0SD3mXlUhCMcltmuIhxw7sOetE/edit'

function localDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: PERU_ZONE }).format(date)
}

function formatDate(date: Date, options: Intl.DateTimeFormatOptions = {}) {
  return new Intl.DateTimeFormat('es-PE', { timeZone: PERU_ZONE, ...options }).format(date)
}

function formatTime(value: string | null | undefined) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('es-PE', {
    timeZone: PERU_ZONE,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}

function timeInputValue(value: string | null | undefined) {
  if (!value) return ''
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: PERU_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value))
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '00'
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '00'
  return `${hour}:${minute}`
}

function peruTimestamp(date: string, time: string) {
  return time ? new Date(`${date}T${time}:00-05:00`).toISOString() : null
}

function getErrorDetail(error: unknown) {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (!error || typeof error !== 'object') return 'Error desconocido.'
  const value = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown }
  const detail = [value.message, value.details, value.hint]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' · ')
  if (detail) {
    if (value.code === 'PGRST202' || value.code === '42883') {
      return `${detail} Ejecuta en Supabase SQL Editor la migración 202611100002_admin_attendance_correction.sql.`
    }
    return value.code ? `${value.code}: ${detail}` : detail
  }
  return typeof value.code === 'string' ? value.code : 'Error desconocido.'
}

function workedTime(record?: AttendanceRecord | null) {
  if (!record?.check_in_at) return '0 h 00 min'
  const end = record.check_out_at ? new Date(record.check_out_at) : new Date()
  const minutes = Math.max(0, Math.floor((end.getTime() - new Date(record.check_in_at).getTime()) / 60000))
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
}

function attendanceMinutes(record: AttendanceRecord, now = new Date()) {
  if (!record.check_in_at) return null
  if (!record.check_out_at && record.work_date !== localDateKey(now)) return null
  const end = record.check_out_at ? new Date(record.check_out_at) : now
  return Math.max(0, Math.floor((end.getTime() - new Date(record.check_in_at).getTime()) / 60000))
}

function formatDuration(minutes: number) {
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
}

function changeMonth(month: string, amount: number) {
  const [year, monthNumber] = month.split('-').map(Number)
  const date = new Date(year, monthNumber - 1 + amount, 1)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function StatusPill({ record }: { record?: AttendanceRecord | null }) {
  if (!record?.check_in_at) return <span className="status-pill status-idle">Sin marcar</span>
  if (!record.check_out_at) return <span className="status-pill status-active"><span className="pulse-dot" /> En jornada</span>
  return <span className="status-pill status-done"><Check size={13} /> Completa</span>
}

function App() {
  const [sessionLoading, setSessionLoading] = useState(true)
  const [session, setSession] = useState<any>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [rememberSession, setRememberSession] = useState(() => localStorage.getItem('dk_remember_session') !== 'false')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordChangeOpen, setPasswordChangeOpen] = useState(false)
  const [passwordSetup, setPasswordSetup] = useState(() => {
    const params = new URLSearchParams(window.location.hash.slice(1))
    return params.get('type') === 'invite' || params.get('type') === 'recovery'
  })
  const [authLinkError] = useState(() => {
    const params = new URLSearchParams(window.location.hash.slice(1))
    if (params.get('error_code') === 'otp_expired') return 'La invitación venció. Pídele al administrador que te envíe una nueva.'
    if (params.get('error')) return 'El enlace de acceso no es válido o ya venció. Pídele al administrador que te envíe uno nuevo.'
    return ''
  })
  const [busy, setBusy] = useState(false)
  const [todayRecords, setTodayRecords] = useState<AttendanceRecord[]>([])
  const [history, setHistory] = useState<AttendanceRecord[]>([])
  const [syncLogs, setSyncLogs] = useState<SyncLog[]>([])
  const [qrSession, setQrSession] = useState<QrSession | null>(null)
  const [pendingQrToken, setPendingQrToken] = useState(() => new URLSearchParams(window.location.search).get('qr'))
  const [pendingAttendanceCode, setPendingAttendanceCode] = useState<string | null>(null)
  const [attendanceCodeInput, setAttendanceCodeInput] = useState('')
  const [todayLoadedFor, setTodayLoadedFor] = useState<string | null>(null)
  const [scanDialog, setScanDialog] = useState<'confirm' | 'success' | null>(null)
  const [scanEvent, setScanEvent] = useState<'Ingreso' | 'Salida'>('Ingreso')
  const [resyncFrom, setResyncFrom] = useState(localDateKey())
  const [resyncTo, setResyncTo] = useState(localDateKey())
  const [adminSection, setAdminSection] = useState<'attendance' | 'correction' | 'history'>('attendance')
  const [lastMarked, setLastMarked] = useState<AttendanceRecord | null>(null)
  const [clock, setClock] = useState(new Date())

  useEffect(() => {
    const url = new URL(window.location.href)
    if (!url.searchParams.has('qr')) return
    url.searchParams.delete('qr')
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
  }, [])

  const loadProfile = useCallback(async (userId: string) => {
    if (!supabase) return
    const { data, error } = await supabase.from('profiles').select('id,full_name,role,is_active').eq('id', userId).maybeSingle()
    if (error) throw error
    setProfile(data as Profile | null)
  }, [])

  const loadData = useCallback(async (currentProfile: Profile) => {
    if (!supabase) return
    const today = localDateKey()
    if (currentProfile.role === 'admin') {
      const [records, sync, profiles] = await Promise.all([
        supabase.from('attendance_records').select('*,worker:profiles!attendance_records_worker_id_fkey(full_name)').eq('work_date', today).order('check_in_at', { ascending: true }),
        supabase.from('sync_log').select('attendance_id,status,error,intentos,updated_at').order('updated_at', { ascending: false }).limit(30),
        supabase.from('profiles').select('id,full_name,role,is_active').eq('role', 'worker').eq('is_active', true).order('full_name'),
      ])
      if (records.error) throw records.error
      if (sync.error) throw sync.error
      if (profiles.error) throw profiles.error
      setTodayRecords((records.data ?? []) as AttendanceRecord[])
      setSyncLogs((sync.data ?? []) as SyncLog[])
      setHistory((profiles.data ?? []).map((worker: any) => ({
        id: worker.id,
        worker_id: worker.id,
        work_date: today,
        check_in_at: null,
        check_out_at: null,
        worker: { full_name: worker.full_name },
      })) as AttendanceRecord[])
    } else {
      const [todayRecord, recent] = await Promise.all([
        supabase.from('attendance_records').select('*').eq('worker_id', currentProfile.id).eq('work_date', today).maybeSingle(),
        supabase.from('attendance_records').select('*').eq('worker_id', currentProfile.id).order('work_date', { ascending: false }).limit(7),
      ])
      if (todayRecord.error) throw todayRecord.error
      if (recent.error) throw recent.error
      setTodayRecords(todayRecord.data ? [todayRecord.data as AttendanceRecord] : [])
      setHistory((recent.data ?? []) as AttendanceRecord[])
      setTodayLoadedFor(currentProfile.id)
    }
  }, [])

  useEffect(() => {
    if (!supabase) {
      setSessionLoading(false)
      return
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setSessionLoading(false)
    })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, currentSession) => {
      setSession(currentSession)
      if (!currentSession) setProfile(null)
      setSessionLoading(false)
    })
    const timer = window.setInterval(() => setClock(new Date()), 30000)
    return () => {
      listener.subscription.unsubscribe()
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (!session?.user?.id) return
    let alive = true
    loadProfile(session.user.id)
      .then(() => { if (alive) setNotice(null) })
      .catch((error) => { if (alive) setNotice({ tone: 'error', text: error.message }) })
    return () => { alive = false }
  }, [session, loadProfile])

  useEffect(() => {
    if (!profile?.is_active) return
    if (profile.role === 'worker') setTodayLoadedFor(null)
    loadData(profile).catch((error) => setNotice({ tone: 'error', text: error.message }))
  }, [profile, loadData])

  useEffect(() => {
    if (!supabase || profile?.role !== 'admin') return
    let alive = true
    void supabase.rpc('get_current_attendance_session').then(({ data, error }) => {
      if (!alive) return
      if (error) {
        setNotice({ tone: 'error', text: 'No se pudo recuperar el QR y la clave. Revisa que las migraciones de asistencia estén aplicadas.' })
        return
      }
      setQrSession(data as QrSession | null)
    })
    return () => { alive = false }
  }, [profile])

  useEffect(() => {
    if (!pendingQrToken || !session || profile?.role !== 'worker' || todayLoadedFor !== profile.id || scanDialog) return
    const record = todayRecords.find((item) => item.worker_id === profile.id)
    setScanEvent(record?.check_in_at ? 'Salida' : 'Ingreso')
    setScanDialog('confirm')
  }, [pendingQrToken, session, profile, todayLoadedFor, todayRecords, scanDialog])

  async function confirmAttendanceScan() {
    if (!supabase || (!pendingQrToken && !pendingAttendanceCode) || !profile || profile.role !== 'worker') return
    setBusy(true)
    setNotice(null)
    try {
      const { data, error } = pendingQrToken
        ? await supabase.rpc('record_attendance_scan', { p_qr_token: pendingQrToken })
        : await supabase.rpc('record_attendance_code', { p_code: pendingAttendanceCode })
      if (error) throw error
      let record = data as AttendanceRecord
      if (!pendingQrToken) {
        const result = data as { ok?: boolean; error?: string; record?: AttendanceRecord }
        if (!result.ok || !result.record) throw new Error(result.error || 'No se pudo validar la clave.')
        record = result.record
      }
      setLastMarked(record)
      setPendingQrToken(null)
      setPendingAttendanceCode(null)
      setAttendanceCodeInput('')
      setScanDialog('success')
      void loadData(profile).catch(() => undefined)
    } catch (error) {
      const message = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
        ? error.message
        : 'No se pudo registrar la marca.'
      setPendingQrToken(null)
      setPendingAttendanceCode(null)
      setScanDialog(null)
      setNotice({ tone: 'error', text: message })
    } finally {
      setBusy(false)
    }
  }

  function submitAttendanceCode() {
    if (!profile || profile.role !== 'worker') return
    const code = attendanceCodeInput.trim()
    if (!/^\d{4}$/.test(code)) {
      setNotice({ tone: 'error', text: 'Ingresa la clave completa de 4 dígitos.' })
      return
    }
    setNotice(null)
    setPendingAttendanceCode(code)
    setScanEvent(todayRecords.find((item) => item.worker_id === profile.id)?.check_in_at ? 'Salida' : 'Ingreso')
    setScanDialog('confirm')
  }

  async function signIn(event: FormEvent) {
    event.preventDefault()
    if (!supabase) return
    setBusy(true)
    setNotice(null)
    localStorage.setItem('dk_remember_session', rememberSession ? 'true' : 'false')
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    if (error) setNotice({ tone: 'error', text: 'No se pudo iniciar sesión. Revisa tu correo y contraseña.' })
    setBusy(false)
  }

  async function savePassword(event: FormEvent) {
    event.preventDefault()
    if (!supabase) return
    if (newPassword.length < 8) {
      setNotice({ tone: 'error', text: 'La contraseña debe tener al menos 8 caracteres.' })
      return
    }
    if (newPassword !== confirmPassword) {
      setNotice({ tone: 'error', text: 'Las contraseñas no coinciden.' })
      return
    }
    setBusy(true)
    setNotice(null)
    const { error } = await supabase.auth.updateUser({ password: newPassword })
    if (error) setNotice({ tone: 'error', text: 'No se pudo guardar la contraseña. Revisa tu sesión y vuelve a intentarlo.' })
    else {
      setPasswordSetup(false)
      setPasswordChangeOpen(false)
      setNewPassword('')
      setConfirmPassword('')
      window.history.replaceState({}, '', window.location.pathname)
      setNotice({ tone: 'success', text: passwordChangeOpen ? 'Contraseña actualizada correctamente.' : 'Contraseña configurada. Ya puedes ingresar a tu cuenta.' })
    }
    setBusy(false)
  }

  async function signOut() {
    if (!supabase) return
    await supabase.auth.signOut()
    setTodayRecords([])
    setHistory([])
    setSyncLogs([])
  }

  async function createQr() {
    if (!supabase) return
    setBusy(true)
    setNotice(null)
    const { data, error } = await supabase.rpc('create_attendance_qr_session')
    if (error) setNotice({ tone: 'error', text: error.message })
    else {
      const createdSession = data as Partial<QrSession>
      setQrSession(createdSession as QrSession)
      setNotice(createdSession.access_code
        ? { tone: 'success', text: 'QR y clave actualizados. Los anteriores ya no funcionan.' }
        : { tone: 'error', text: 'Se generó el QR, pero Supabase no devolvió la clave. Ejecuta la migración de clave corta y vuelve a generar.' })
    }
    setBusy(false)
  }

  async function resync() {
    if (!supabase) return
    setBusy(true)
    setNotice(null)
    const { data, error } = await supabase.rpc('queue_attendance_resync', {
      p_from_date: resyncFrom,
      p_to_date: resyncTo,
    })
    if (error) setNotice({ tone: 'error', text: error.message })
    else {
      setNotice({ tone: 'success', text: `${data ?? 0} registro(s) puestos en cola para sincronizar.` })
      if (profile) await loadData(profile)
    }
    setBusy(false)
  }

  if (sessionLoading) return <div className="screen-center"><span className="loader" /> Cargando asistencia…</div>

  if (!isSupabaseConfigured) return <SetupNotice />

  if (session && passwordSetup) return (
    <main className="setup-page">
      <section className="setup-card password-setup-card">
        <div className="brand-mark">DK</div>
        <span className="eyebrow">ACTIVA TU CUENTA</span>
        <h1>Define tu contraseña</h1>
        <p>Elige una contraseña para ingresar al control de asistencia.</p>
        <form onSubmit={savePassword} className="form-stack">
          <label>Nueva contraseña<input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" minLength={8} required /></label>
          <label>Confirma la contraseña<input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={8} required /></label>
          {notice && <Notice notice={notice} />}
          <button className="button button-primary button-wide" disabled={busy}>{busy ? 'Guardando…' : 'Guardar contraseña'}</button>
        </form>
      </section>
    </main>
  )

  if (!session) return (
    <main className="login-shell">
      <div className="login-visual">
        <div className="brand"><span className="brand-mark">DK</span><span>DK PARTNERS</span></div>
        <div className="login-message">
          <span className="eyebrow">CONTROL DE ASISTENCIA</span>
          <h1>Tu jornada,<br /><em>en orden.</em></h1>
          <p>Un registro claro para empezar y cerrar cada día de trabajo.</p>
        </div>
        <div className="visual-footer"><span>ASISTENCIA · NOVIEMBRE 2026</span><span>01 — 30</span></div>
        <div className="visual-orbit orbit-one" /><div className="visual-orbit orbit-two" />
      </div>
      <section className="login-panel">
        <div className="login-mobile-brand"><span className="brand-mark">DK</span><span>DK PARTNERS</span></div>
        <div className="login-form-wrap">
          <span className="eyebrow">PORTAL DEL EQUIPO</span>
          <h2>Bienvenido</h2>
          <p className="muted">Ingresa con el correo y contraseña de tu cuenta.</p>
          {authLinkError && <div className="inline-notice notice-error"><span><X size={17} /></span><span>{authLinkError}</span></div>}
          {pendingQrToken && <div className="inline-notice notice-info"><ShieldCheck size={17} /> QR leído. Inicia sesión para confirmar tu marca.</div>}
          <form onSubmit={signIn} className="form-stack">
            <label>Correo electrónico<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="nombre@dkpartners.com" autoComplete="username" required /></label>
            <label>Contraseña<div className="password-input-wrap"><input type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Tu contraseña" autoComplete="current-password" required /><button className="password-visibility" type="button" onClick={() => setShowPassword((visible) => !visible)} aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'} aria-pressed={showPassword}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label>
            <label className="remember-option"><input type="checkbox" checked={rememberSession} onChange={(event) => setRememberSession(event.target.checked)} /><span>Mantener sesión iniciada</span></label>
            {notice && <Notice notice={notice} />}
            <button className="button button-primary button-wide" disabled={busy}>{busy ? 'Ingresando…' : 'Ingresar'} <ArrowRight size={17} /></button>
            <p className="auth-help-note">¿Olvidaste tu contraseña? Pídele al administrador que te asigne una temporal.</p>
          </form>
          <p className="login-footnote"><ShieldCheck size={15} /> Acceso privado para el equipo DK Partners</p>
        </div>
        <div className="login-panel-footer">¿Necesitas acceso? Pídele una cuenta al administrador.</div>
      </section>
    </main>
  )

  if (!profile) return <div className="screen-center"><span className="loader" /> Preparando tu cuenta…</div>
  if (!profile.is_active) return <main className="screen-center"><div className="empty-state"><ShieldCheck size={28} /><h2>Cuenta desactivada</h2><p>Contacta al administrador de DK Partners.</p><button className="button button-secondary" onClick={signOut}>Cerrar sesión</button></div></main>

  if (passwordChangeOpen) return (
    <main className="setup-page">
      <section className="setup-card password-setup-card">
        <div className="brand-mark">DK</div>
        <span className="eyebrow">SEGURIDAD DE LA CUENTA</span>
        <h1>Cambia tu contraseña</h1>
        <p>Actualiza tu clave de acceso. No se enviará ningún correo.</p>
        <form onSubmit={savePassword} className="form-stack">
          <label>Nueva contraseña<input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" minLength={8} required /></label>
          <label>Confirma la contraseña<input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={8} required /></label>
          {notice && <Notice notice={notice} />}
          <button className="button button-primary button-wide" disabled={busy}>{busy ? 'Guardando…' : 'Guardar contraseña'}</button>
          <button type="button" className="auth-help-button" onClick={() => { setPasswordChangeOpen(false); setNewPassword(''); setConfirmPassword(''); setNotice(null) }}>Volver a asistencia</button>
        </form>
      </section>
    </main>
  )

  const isAdmin = profile.role === 'admin'
  const ownRecord = todayRecords.find((record) => record.worker_id === profile.id)
  const displayDate = formatDate(clock, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand brand-dark"><span className="brand-mark">DK</span><span>DK PARTNERS</span></div>
        <div className="side-nav-groups">
          <div className="sidebar-group">
            <div className="side-label">ESPACIO DE TRABAJO</div>
            <button type="button" className={`side-nav-item ${adminSection === 'attendance' ? 'active' : ''}`} onClick={() => setAdminSection('attendance')} title="Asistencia"><CalendarDays size={18} /><span>Asistencia</span></button>
            <button type="button" className={`side-nav-item ${adminSection === 'history' ? 'active' : ''}`} onClick={() => setAdminSection('history')} title={isAdmin ? 'Horarios del equipo' : 'Mi Registro de Horas'}>{isAdmin ? <Users size={18} /> : <HistoryIcon size={18} />}<span>{isAdmin ? 'Horarios del equipo' : 'Mi Registro de Horas'}</span></button>
          </div>
          {isAdmin && <div className="sidebar-group">
            <div className="side-label side-label-admin">ADMINISTRACIÓN</div>
            <button type="button" className={`side-nav-item ${adminSection === 'correction' ? 'active' : ''}`} onClick={() => setAdminSection('correction')} title="Corregir asistencia"><Clock3 size={18} /><span>Corregir asistencia</span></button>
          </div>}
        </div>
        <div className="sidebar-bottom"><div className="sidebar-stamp">DK<span>·</span>26</div><span>CONTROL INTERNO</span></div>
      </aside>
      <section className="main-column">
        <header className="topbar">
          <div className="breadcrumb"><span>{isAdmin ? adminSection === 'history' ? 'Espacio de trabajo' : 'Administración' : 'Espacio de trabajo'}</span><span className="crumb-slash">/</span><strong>{isAdmin && adminSection === 'correction' ? 'Corregir asistencia' : adminSection === 'history' ? isAdmin ? 'Horarios del equipo' : 'Mi Registro de Horas' : 'Asistencia'}</strong></div>
          <div className="topbar-user"><div className="avatar">{profile.full_name?.slice(0, 1).toUpperCase() || 'D'}</div><div className="user-copy"><strong>{profile.full_name}</strong><span>{isAdmin ? 'Administrador' : 'Trabajador'}</span></div><button className="text-button password-change-trigger" onClick={() => { setNotice(null); setPasswordChangeOpen(true) }}>Cambiar contraseña</button><button className="icon-button" aria-label="Cerrar sesión" title="Cerrar sesión" onClick={signOut}><LogOut size={17} /></button></div>
        </header>
        <div className="page-content">
          <div className="page-heading"><div><span className="eyebrow">{isAdmin ? adminSection === 'correction' ? 'ADMINISTRACIÓN' : adminSection === 'history' ? 'EQUIPO' : 'PANEL DE CONTROL' : adminSection === 'history' ? 'MI REGISTRO DE HORAS' : 'MI ASISTENCIA'}</span><h1>{isAdmin && adminSection === 'correction' ? 'Corregir asistencia' : adminSection === 'history' ? isAdmin ? 'Horarios del equipo' : 'Mi Registro de Horas' : `Hola, ${profile.full_name?.split(' ')[0]}`}<span className="heading-period">.</span></h1><p>{isAdmin && adminSection === 'correction' ? 'Ajusta una marca y registra el motivo del cambio.' : adminSection === 'history' ? isAdmin ? 'Consulta las horas y marcas de cada trabajador.' : 'Consulta tus entradas, salidas y horas registradas.' : displayDate}</p>{(!isAdmin || adminSection === 'attendance') && <a className="sheet-link sheet-link-prominent" href={GOOGLE_SHEETS_URL} target="_blank" rel="noreferrer"><ExternalLink size={15} /> Ver hoja de asistencia</a>}</div><div className="live-clock"><span className="live-dot" /> HORA DE PERÚ <strong>{formatDate(clock, { hour: 'numeric', minute: '2-digit' })}</strong></div></div>
          {notice && <Notice notice={notice} dismiss={() => setNotice(null)} />}
          {scanDialog && !isAdmin && <AttendanceScanDialog
            mode={scanDialog}
            event={scanEvent}
            busy={busy}
            onConfirm={confirmAttendanceScan}
            onCancel={() => { setScanDialog(null); setPendingQrToken(null); setPendingAttendanceCode(null) }}
            onClose={() => setScanDialog(null)}
          />}

          {adminSection === 'history' ? (
            isAdmin ? <AdminTeamHistory workers={history} clock={clock} /> : <WorkerHistoryDashboard workerId={profile.id} clock={clock} />
          ) : isAdmin && adminSection === 'correction' ? (
            <AttendanceCorrectionPanel workers={history} onSaved={() => profile ? loadData(profile) : Promise.resolve()} />
          ) : isAdmin ? (
            <AdminDashboard
              records={todayRecords}
              workers={history}
              logs={syncLogs}
              qrSession={qrSession}
              busy={busy}
              from={resyncFrom}
              to={resyncTo}
              setFrom={setResyncFrom}
              setTo={setResyncTo}
              onCreateQr={createQr}
              onResync={resync}
              clock={clock}
            />
          ) : (
            <WorkerDashboard
              record={ownRecord}
              history={history}
              lastMarked={lastMarked}
              code={attendanceCodeInput}
              onCodeChange={setAttendanceCodeInput}
              onSubmitCode={submitAttendanceCode}
              busy={busy}
              clock={clock}
              onRefresh={() => loadData(profile).catch((error) => setNotice({ tone: 'error', text: error.message }))}
            />
          )}
          <footer className="app-footer"><span>DK PARTNERS <span className="footer-dot">·</span> CONTROL DE ASISTENCIA</span><span>Los registros oficiales se guardan en Supabase.</span></footer>
        </div>
      </section>
    </main>
  )
}

function AdminTeamHistory({ workers, clock }: { workers: AttendanceRecord[]; clock: Date }) {
  const [workerId, setWorkerId] = useState('')

  useEffect(() => {
    if (!workers.some((worker) => worker.worker_id === workerId)) {
      setWorkerId(workers[0]?.worker_id ?? '')
    }
  }, [workerId, workers])

  return <div className="team-history-page">
    <section className="panel team-history-picker">
      <div className="team-history-picker-copy"><span className="eyebrow">TRABAJADORES ACTIVOS</span><strong>Selecciona a quién consultar</strong></div>
      <label>Trabajador<select value={workerId} onChange={(event) => setWorkerId(event.target.value)} disabled={workers.length === 0}>
        {workers.map((worker) => <option key={worker.worker_id} value={worker.worker_id}>{worker.worker?.full_name || 'Trabajador'}</option>)}
      </select></label>
    </section>
    {workerId ? <WorkerHistoryDashboard key={workerId} workerId={workerId} clock={clock} /> : <section className="panel team-history-empty">No hay trabajadores activos para mostrar.</section>}
  </div>
}

function WorkerHistoryDashboard({ workerId, clock }: { workerId: string; clock: Date }) {
  const [month, setMonth] = useState(() => localDateKey().slice(0, 7))
  const [records, setRecords] = useState<AttendanceRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [year, monthNumber] = month.split('-').map(Number)
  const monthLength = new Date(year, monthNumber, 0).getDate()
  const monthStart = `${month}-01`
  const monthEnd = `${month}-${String(monthLength).padStart(2, '0')}`
  const todayMonth = localDateKey(clock).slice(0, 7)

  useEffect(() => {
    let alive = true
    if (!supabase) return
    setLoading(true)
    setError('')
    supabase.from('attendance_records').select('*')
      .eq('worker_id', workerId)
      .gte('work_date', monthStart)
      .lte('work_date', monthEnd)
      .order('work_date', { ascending: true })
      .then(({ data, error: queryError }) => {
        if (!alive) return
        if (queryError) {
          setError(queryError.message)
          setRecords([])
          return
        }
        setRecords((data ?? []) as AttendanceRecord[])
      })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [workerId, monthStart, monthEnd])

  const recordByDate = new Map(records.map((record) => [record.work_date, record]))
  const markedDays = records.filter((record) => record.check_in_at).length
  const completeDays = records.filter((record) => record.check_in_at && record.check_out_at).length
  const totalMinutes = records.reduce((sum, record) => sum + (attendanceMinutes(record, clock) ?? 0), 0)
  const monthDate = new Date(`${month}-01T12:00:00-05:00`)

  return <div className="worker-history-page">
    <section className="history-summary-grid">
      <article className="history-summary-card"><span>DÍAS CON MARCA</span><strong>{String(markedDays).padStart(2, '0')}</strong><small>En este mes</small></article>
      <article className="history-summary-card"><span>JORNADAS COMPLETAS</span><strong>{String(completeDays).padStart(2, '0')}</strong><small>Con entrada y salida</small></article>
      <article className="history-summary-card history-summary-total"><span>HORAS REGISTRADAS</span><strong>{formatDuration(totalMinutes)}</strong><small>Incluye la jornada de hoy en curso</small></article>
    </section>
    <section className="panel month-history-panel">
      <div className="panel-heading month-history-heading">
        <div><span className="eyebrow">DETALLE DIARIO</span><h2>{formatDate(monthDate, { month: 'long', year: 'numeric' })}</h2></div>
        <div className="month-controls">
          <button className="icon-button icon-button-light" type="button" aria-label="Mes anterior" onClick={() => setMonth((current) => changeMonth(current, -1))}><ChevronLeft size={17} /></button>
          <button className="icon-button icon-button-light" type="button" aria-label="Mes siguiente" disabled={month >= todayMonth} onClick={() => setMonth((current) => changeMonth(current, 1))}><ChevronRight size={17} /></button>
        </div>
      </div>
      {error && <div className="history-load-error"><Notice notice={{ tone: 'error', text: `No se pudo cargar tu historial: ${error}` }} /></div>}
      {loading ? <div className="history-loading"><span className="loader loader-small" /> Cargando historial…</div> : <>
        <div className="month-history-grid">
          {Array.from({ length: monthLength }, (_, index) => {
            const day = index + 1
            const dateKey = `${month}-${String(day).padStart(2, '0')}`
            const date = new Date(`${dateKey}T12:00:00-05:00`)
            const record = recordByDate.get(dateKey)
            const elapsed = record ? attendanceMinutes(record, clock) : null
            const status = record?.check_out_at ? 'complete' : record?.check_in_at ? 'open' : 'empty'
            return <article className={`month-day-card month-day-${status}`} key={dateKey}>
              <div className="month-day-heading"><div><span>{formatDate(date, { weekday: 'short' }).replace('.', '')}</span><strong>{String(day).padStart(2, '0')}</strong></div><span className={`month-day-status status-${status}`}>{status === 'complete' ? <><CheckCircle2 size={13} /> Jornada completa</> : status === 'open' ? <><span className="month-status-pulse" /> EN CURSO</> : 'Sin marca'}</span></div>
              <div className="month-day-times"><div><span>ENTRADA</span><strong>{formatTime(record?.check_in_at)}</strong></div><div><span>SALIDA</span><strong>{formatTime(record?.check_out_at)}</strong></div></div>
              <div className="month-day-total"><span>HORAS</span><strong>{elapsed === null ? record?.check_in_at ? 'Pendiente' : '—' : formatDuration(elapsed)}</strong></div>
            </article>
          })}
        </div>
        {records.length === 0 && <div className="month-history-empty"><CalendarDays size={18} /> Aún no tienes marcas registradas en este mes.</div>}
      </>}
      <div className="month-history-foot"><span>Horario mostrado en hora de Perú</span><span>Solo tú puedes ver este historial</span></div>
    </section>
  </div>
}

function AttendanceScanDialog(props: {
  mode: 'confirm' | 'success'
  event: 'Ingreso' | 'Salida'
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
  onClose: () => void
}) {
  const { mode, event, busy, onConfirm, onCancel, onClose } = props
  return <div className="scan-modal-backdrop">
    <section className="scan-modal" role="dialog" aria-modal="true" aria-labelledby="scan-modal-title">
      <div className={`scan-modal-icon ${mode === 'success' ? 'scan-modal-icon-success' : ''}`}>
        {mode === 'success' ? <CheckCircle2 size={25} /> : <ShieldCheck size={25} />}
      </div>
      <span className="eyebrow">CONTROL DE ASISTENCIA</span>
      <h2 id="scan-modal-title">{mode === 'success' ? '¡Marca registrada!' : `¿Confirmas tu ${event.toLowerCase()}?`}</h2>
      <p>{mode === 'success'
        ? `Tu asistencia de ${event.toLowerCase()} quedó guardada en Supabase. La copia de Google Sheets se sincroniza en segundo plano.`
        : `Se registrará tu ${event.toLowerCase()} con la hora actual. Confirma solo si estás listo para marcar.`}</p>
      {mode === 'confirm' ? <div className="scan-modal-actions">
        <button className="button button-secondary" onClick={onCancel} disabled={busy}>Cancelar</button>
        <button className="button button-primary" onClick={onConfirm} disabled={busy}>{busy ? 'Registrando…' : 'Sí, registrar'}</button>
      </div> : <button className="button button-primary button-wide" onClick={onClose}>Aceptar</button>}
    </section>
  </div>
}

function Notice({ notice, dismiss }: { notice: Notice; dismiss?: () => void }) {
  return <div className={`inline-notice notice-${notice.tone}`}><span>{notice.tone === 'success' ? <CheckCircle2 size={17} /> : notice.tone === 'error' ? <X size={17} /> : <ShieldCheck size={17} />}</span><span>{notice.text}</span>{dismiss && <button onClick={dismiss} aria-label="Cerrar aviso"><X size={15} /></button>}</div>
}

function SetupNotice() {
  return <main className="setup-page"><div className="setup-card"><div className="brand-mark">DK</div><span className="eyebrow">PRIMERA CONFIGURACIÓN</span><h1>Conecta el proyecto</h1><p>La interfaz ya está lista. Para guardar marcas de forma segura, agrega las credenciales públicas de tu proyecto Supabase en el archivo local <code>.env.local</code>.</p><pre>VITE_SUPABASE_URL=https://…supabase.co<br />VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_…</pre><p className="small-muted">Las credenciales privadas de Google Sheets y Supabase nunca van en este archivo del navegador.</p></div></main>
}

function AdminDashboard(props: {
  records: AttendanceRecord[]; workers: AttendanceRecord[]; logs: SyncLog[]; qrSession: QrSession | null; busy: boolean; from: string; to: string;
  setFrom: (value: string) => void; setTo: (value: string) => void; onCreateQr: () => void; onResync: () => void; clock: Date;
}) {
  const { records, workers, logs, qrSession, busy, from, to, setFrom, setTo, onCreateQr, onResync, clock } = props
  const workersWithRecord = workers.map((worker) => ({ ...worker, ...(records.find((record) => record.worker_id === worker.worker_id) ?? {}) }))
  const present = records.filter((record) => record.check_in_at).length
  const completed = records.filter((record) => record.check_out_at).length
  const pendingSync = logs.filter((log) => log.status === 'pending' || log.status === 'processing' || log.status === 'error').length
  const qrUrl = qrSession ? `${window.location.origin}/?qr=${encodeURIComponent(qrSession.token)}` : ''

  return <>
    <section className="metric-grid">
      <Metric icon={<Users size={18} />} label="TRABAJADORES" value={String(workers.length).padStart(2, '0')} note="Cuentas activas" tone="mint" />
      <Metric icon={<ArrowDownToLine size={18} />} label="PRESENTES HOY" value={`${String(present).padStart(2, '0')} / ${String(workers.length).padStart(2, '0')}`} note="Han marcado entrada" tone="blue" />
      <Metric icon={<CheckCircle2 size={18} />} label="JORNADAS CERRADAS" value={String(completed).padStart(2, '0')} note="Con entrada y salida" tone="lavender" />
      <Metric icon={<RefreshCw size={18} />} label="POR SINCRONIZAR" value={String(pendingSync).padStart(2, '0')} note="En la cola de Sheets" tone={pendingSync ? 'amber' : 'mint'} />
    </section>

    <div className="dashboard-grid">
      <section className="panel attendance-panel">
        <div className="panel-heading"><div><span className="eyebrow">HOY · {formatDate(clock, { day: '2-digit', month: 'short' }).toUpperCase()}</span><h2>Equipo en jornada</h2></div><button className="text-button" onClick={() => window.location.reload()}>Actualizar <RefreshCw size={14} /></button></div>
        <div className="table-wrap"><table><thead><tr><th>TRABAJADOR</th><th>ENTRADA</th><th>SALIDA</th><th>HORAS</th><th>ESTADO</th></tr></thead><tbody>
          {workersWithRecord.map((record) => <tr key={record.worker_id}><td><div className="person-cell"><div className="avatar avatar-small">{record.worker?.full_name?.slice(0, 1) || '?'}</div><strong>{record.worker?.full_name || 'Trabajador'}</strong></div></td><td>{formatTime(record.check_in_at)}</td><td>{formatTime(record.check_out_at)}</td><td className="hours-cell">{workedTime(record)}</td><td><StatusPill record={record} /></td></tr>)}
          {workersWithRecord.length === 0 && <tr><td colSpan={5}><div className="table-empty"><Users size={20} /><span>Aún no hay trabajadores activos.</span></div></td></tr>}
        </tbody></table></div>
        <div className="panel-foot"><span><span className="live-dot" /> Actualizado en tiempo real al cargar</span><span>{present} de {workers.length} presentes</span></div>
      </section>

      <section className="panel qr-panel">
        <div className="panel-heading"><div><span className="eyebrow">MARCAJE DEL EQUIPO</span><h2>Código QR</h2></div><div className="qr-live"><span className="live-dot" /> ACTIVO</div></div>
        <p className="panel-description">Muestra este código al equipo para registrar entrada o salida. Renovarlo invalida el anterior.</p>
        <div className={`qr-frame ${qrSession ? 'qr-ready' : ''}`}>
          {qrSession ? <QRCodeSVG value={qrUrl} size={148} level="H" includeMargin /> : <div className="qr-placeholder"><div className="qr-corner qr-corner-tl" /><div className="qr-corner qr-corner-tr" /><div className="qr-corner qr-corner-bl" /><div className="qr-grid"><span /><span /><span /><span /><span /><span /><span /><span /><span /></div></div>}
        </div>
        <div className="qr-caption">{qrSession ? `Válido hasta ${formatTime(qrSession.expires_at)}` : 'Genera el código para iniciar los marcajes'}</div>
        {qrSession?.access_code && <div className="attendance-short-code"><span>CLAVE MANUAL</span><strong>{qrSession.access_code}</strong><small>El equipo puede escanear el QR o ingresar esta clave.</small></div>}
        <button className="button button-primary button-wide" onClick={onCreateQr} disabled={busy}><RefreshCw size={16} className={busy ? 'spin' : ''} /> {qrSession ? 'Renovar QR y clave' : 'Generar QR y clave'}</button>
        <div className="qr-note"><ShieldCheck size={14} /> QR y clave vencen juntos a las 12 horas</div>
      </section>

      <section className="panel sync-panel">
        <div className="panel-heading"><div><span className="eyebrow">GOOGLE SHEETS</span><h2>Sincronización</h2></div><div className="sync-indicator"><span className={pendingSync ? 'sync-dot sync-warn' : 'sync-dot'} />{pendingSync ? 'Revisar cola' : 'Operativa'}</div></div>
        <p className="panel-description">Supabase guarda cada marca primero. Los registros pendientes vuelven a intentarse automáticamente.</p>
        <div className="date-range-row"><label>Desde<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label><ArrowRight size={16} /><label>Hasta<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label></div>
        <button className="button button-secondary button-wide" onClick={onResync} disabled={busy || !from || !to || from > to}><RefreshCw size={16} /> Re-sincronizar con Google Sheets</button>
        <div className="sync-history"><div className="sync-history-title"><span>ÚLTIMOS EVENTOS</span><button className="icon-button icon-button-light" aria-label="Actualizar eventos" onClick={() => window.location.reload()}><RefreshCw size={14} /></button></div>
          {logs.slice(0, 3).map((log) => <div className="sync-row" key={log.attendance_id}><span className={`sync-state state-${log.status}`} /><span className="sync-row-label">{log.status === 'synced' ? 'Sincronizado' : log.status === 'error' ? log.error || 'Error de sincronización' : log.status === 'processing' ? 'Enviando a Google Sheets' : 'Pendiente de envío'}</span><span className="sync-row-time">{formatTime(log.updated_at)}</span></div>)}
          {logs.length === 0 && <div className="sync-empty">Todavía no hay registros en la cola.</div>}
        </div>
      </section>

    </div>
  </>
}

type AttendanceAdjustment = {
  id: string
  worker_id: string
  work_date: string
  reason: string
  old_check_in_at: string | null
  old_check_out_at: string | null
  new_check_in_at: string | null
  new_check_out_at: string | null
  created_at: string
}

function AttendanceCorrectionPanel({ workers, onSaved }: { workers: AttendanceRecord[]; onSaved: () => Promise<void> }) {
  const [workerId, setWorkerId] = useState('')
  const [workDate, setWorkDate] = useState(localDateKey())
  const [checkIn, setCheckIn] = useState('')
  const [checkOut, setCheckOut] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [loadingRecord, setLoadingRecord] = useState(false)
  const [adjustments, setAdjustments] = useState<AttendanceAdjustment[]>([])
  const [message, setMessage] = useState<Notice | null>(null)
  const workerName = (id: string) => workers.find((worker) => worker.worker_id === id)?.worker?.full_name || 'Trabajador'

  useEffect(() => {
    if (!workerId && workers.length) setWorkerId(workers[0].worker_id)
  }, [workerId, workers])

  const loadAdjustments = useCallback(async () => {
    if (!supabase) return
    const { data, error } = await supabase.from('attendance_adjustments')
      .select('id,worker_id,work_date,reason,old_check_in_at,old_check_out_at,new_check_in_at,new_check_out_at,created_at')
      .order('created_at', { ascending: false })
      .limit(5)
    if (error) throw error
    setAdjustments((data ?? []) as AttendanceAdjustment[])
  }, [])

  useEffect(() => {
    let alive = true
    if (!supabase || !workerId || !workDate) return
    setLoadingRecord(true)
    setMessage(null)
    supabase.from('attendance_records').select('check_in_at,check_out_at')
      .eq('worker_id', workerId).eq('work_date', workDate).maybeSingle()
      .then(({ data, error }) => {
        if (!alive) return
        if (error) {
          setMessage({ tone: 'error', text: `No se pudo cargar la marca: ${error.message}` })
          return
        }
        setCheckIn(timeInputValue(data?.check_in_at))
        setCheckOut(timeInputValue(data?.check_out_at))
      })
      .finally(() => { if (alive) setLoadingRecord(false) })
    return () => { alive = false }
  }, [workerId, workDate])

  useEffect(() => {
    void loadAdjustments().catch((error) => {
      const detail = getErrorDetail(error)
      setMessage({ tone: 'error', text: `No se pudo cargar la auditoría: ${detail}` })
    })
  }, [loadAdjustments])

  async function submitCorrection(event: FormEvent) {
    event.preventDefault()
    if (!supabase || !workerId || !workDate) return
    if (reason.trim().length < 5) {
      setMessage({ tone: 'error', text: 'Escribe el motivo de la corrección (mínimo 5 caracteres).' })
      return
    }
    if (checkOut && !checkIn) {
      setMessage({ tone: 'error', text: 'Para registrar una salida también debes indicar la entrada.' })
      return
    }
    const checkInAt = peruTimestamp(workDate, checkIn)
    const checkOutAt = peruTimestamp(workDate, checkOut)
    if (checkInAt && checkOutAt && new Date(checkOutAt) < new Date(checkInAt)) {
      setMessage({ tone: 'error', text: 'La salida no puede ser anterior a la entrada.' })
      return
    }
    setSaving(true)
    setMessage(null)
    try {
      const { error } = await supabase.rpc('admin_correct_attendance', {
        p_worker_id: workerId,
        p_work_date: workDate,
        p_check_in_at: checkInAt,
        p_check_out_at: checkOutAt,
        p_reason: reason.trim(),
      })
      if (error) throw error
      setReason('')
      setMessage({ tone: 'success', text: 'Corrección guardada en Supabase y puesta en cola para Google Sheets.' })
      const refreshes = await Promise.allSettled([onSaved(), loadAdjustments()])
      if (refreshes.some((result) => result.status === 'rejected')) {
        setMessage({ tone: 'info', text: 'La corrección sí se guardó y quedó en cola. Actualiza el panel para ver los datos más recientes.' })
      }
    } catch (error) {
      const detail = getErrorDetail(error)
      setMessage({ tone: 'error', text: `No se pudo guardar la corrección: ${detail}` })
    } finally {
      setSaving(false)
    }
  }

  return <section className="panel correction-panel">
    <div className="panel-heading"><div><span className="eyebrow">ADMINISTRACIÓN</span><h2>Corregir asistencia</h2></div><ShieldCheck size={18} className="muted-icon" /></div>
    <p className="panel-description">La corrección se guarda en Supabase, exige un motivo y vuelve a poner esa fecha en la cola de sincronización.</p>
    <form className="correction-form" onSubmit={submitCorrection}>
      <label>Trabajador<select value={workerId} onChange={(event) => setWorkerId(event.target.value)} required disabled={saving || workers.length === 0}>
        {workers.map((worker) => <option key={worker.worker_id} value={worker.worker_id}>{worker.worker?.full_name || 'Trabajador'}</option>)}
      </select></label>
      <label>Fecha<input type="date" value={workDate} onChange={(event) => setWorkDate(event.target.value)} required disabled={saving} /></label>
      <label>Entrada<input type="time" value={checkIn} onChange={(event) => setCheckIn(event.target.value)} disabled={saving || loadingRecord} /></label>
      <label>Salida<input type="time" value={checkOut} onChange={(event) => setCheckOut(event.target.value)} disabled={saving || loadingRecord} /></label>
      <label className="correction-reason">Motivo de la corrección<input type="text" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Ej.: marcó tarde por una emergencia" minLength={5} maxLength={300} required disabled={saving} /></label>
      <button className="button button-primary correction-submit" type="submit" disabled={saving || loadingRecord || !workerId}>{saving ? 'Guardando…' : 'Guardar corrección'}</button>
    </form>
    <div className="correction-footnote">Los horarios se interpretan como hora de Perú (UTC−5). Dejar ambos horarios vacíos limpia las marcas de ese día.</div>
    {message && <div className="correction-message"><Notice notice={message} /></div>}
    <div className="adjustment-history"><strong>Últimas correcciones</strong>
      {adjustments.map((adjustment) => <div className="adjustment-row" key={adjustment.id}>
        <span><b>{workerName(adjustment.worker_id)}</b> · {formatDate(new Date(`${adjustment.work_date}T12:00:00`), { day: '2-digit', month: 'short' })}</span>
        <span>{timeInputValue(adjustment.old_check_in_at) || '—'} / {timeInputValue(adjustment.old_check_out_at) || '—'} → {timeInputValue(adjustment.new_check_in_at) || '—'} / {timeInputValue(adjustment.new_check_out_at) || '—'}</span>
        <small>{adjustment.reason}</small>
      </div>)}
      {adjustments.length === 0 && <span className="adjustment-empty">Aún no hay correcciones.</span>}
    </div>
  </section>
}

function Metric({ icon, label, value, note, tone }: { icon: ReactNode; label: string; value: string; note: string; tone: string }) {
  return <article className="metric-card"><div className={`metric-icon tone-${tone}`}>{icon}</div><span className="metric-label">{label}</span><strong className="metric-value">{value}</strong><span className="metric-note">{note}</span><ArrowUpRight size={15} className="metric-arrow" /></article>
}

function WorkerDashboard({ record, history, lastMarked, code, onCodeChange, onSubmitCode, busy, clock, onRefresh }: { record?: AttendanceRecord; history: AttendanceRecord[]; lastMarked: AttendanceRecord | null; code: string; onCodeChange: (value: string) => void; onSubmitCode: () => void; busy: boolean; clock: Date; onRefresh: () => void }) {
  const hasStarted = Boolean(record?.check_in_at)
  const hasFinished = Boolean(record?.check_out_at)
  return <div className="worker-grid">
    <section className="panel worker-status-panel">
      <div className="panel-heading"><div><span className="eyebrow">MI JORNADA · {formatDate(clock, { day: '2-digit', month: 'short' }).toUpperCase()}</span><h2>Estado de hoy</h2></div><button className="icon-button icon-button-light" aria-label="Actualizar" onClick={onRefresh}><RefreshCw size={16} /></button></div>
      {lastMarked && <div className="mark-success"><CheckCircle2 size={19} /><div><strong>Marca registrada</strong><span>{lastMarked.check_out_at ? 'Salida' : 'Entrada'} · {formatTime(lastMarked.check_out_at || lastMarked.check_in_at)}</span></div></div>}
      <div className="work-summary"><div className="work-summary-icon"><Clock3 size={20} /></div><div><span>TIEMPO TRABAJADO</span><strong>{workedTime(record)}</strong></div><StatusPill record={record} /></div>
      <div className="timeline"><div className={`timeline-item ${hasStarted ? 'timeline-complete' : 'timeline-next'}`}><span className="timeline-marker">{hasStarted ? <Check size={13} /> : <ArrowDownToLine size={13} />}</span><div><span>ENTRADA</span><strong>{formatTime(record?.check_in_at)}</strong></div><small>{hasStarted ? 'Registrada' : 'Pendiente'}</small></div><div className="timeline-divider" /><div className={`timeline-item ${hasFinished ? 'timeline-complete' : hasStarted ? 'timeline-next' : ''}`}><span className="timeline-marker">{hasFinished ? <Check size={13} /> : <ArrowUpRight size={13} />}</span><div><span>SALIDA</span><strong>{formatTime(record?.check_out_at)}</strong></div><small>{hasFinished ? 'Registrada' : hasStarted ? 'Al volver a escanear' : 'Pendiente'}</small></div></div>
      <div className="scan-hint"><ShieldCheck size={16} /><p>Escanea el QR o ingresa la clave de 4 dígitos que muestra tu jefe para registrar {hasStarted ? 'tu salida' : 'tu entrada'}.</p></div>
      <form className="attendance-code-form" onSubmit={(event) => { event.preventDefault(); onSubmitCode() }}>
        <label htmlFor="attendance-code">¿No puedes escanear? Escribe la clave</label>
        <div><input id="attendance-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{4}" maxLength={4} placeholder="0000" value={code} onChange={(event) => onCodeChange(event.target.value.replace(/\D/g, '').slice(0, 4))} disabled={busy || hasFinished} /><button className="button button-secondary" type="submit" disabled={busy || hasFinished || code.length !== 4}>Continuar</button></div>
      </form>
      {busy && <div className="loading-line"><span className="loader loader-small" /> Procesando marca…</div>}
    </section>
    <section className="panel history-panel"><div className="panel-heading"><div><span className="eyebrow">TU REGISTRO</span><h2>Últimos días</h2></div><CalendarDays size={19} className="muted-icon" /></div><div className="history-list">{history.map((item) => <div className="history-item" key={item.id}><div className="history-day"><strong>{formatDate(new Date(`${item.work_date}T12:00:00`), { day: '2-digit' })}</strong><span>{formatDate(new Date(`${item.work_date}T12:00:00`), { month: 'short' }).replace('.', '')}</span></div><div className="history-date"><strong>{formatDate(new Date(`${item.work_date}T12:00:00`), { weekday: 'long' })}</strong><span>{formatTime(item.check_in_at)} — {formatTime(item.check_out_at)}</span></div><div className="history-hours">{workedTime(item)}</div></div>)}{history.length === 0 && <div className="history-empty">Tus marcas aparecerán aquí.</div>}</div><div className="history-foot"><span>Zona horaria</span><strong>Perú · UTC−5</strong></div></section>
  </div>
}

export default App
