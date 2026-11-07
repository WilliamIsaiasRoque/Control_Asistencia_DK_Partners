import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  CheckCircle2,
  Clock3,
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

type QrSession = { token: string; expires_at: string }
type Notice = { tone: 'success' | 'error' | 'info'; text: string }

const PERU_ZONE = 'America/Lima'

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

function workedTime(record?: AttendanceRecord | null) {
  if (!record?.check_in_at) return '0 h 00 min'
  const end = record.check_out_at ? new Date(record.check_out_at) : new Date()
  const minutes = Math.max(0, Math.floor((end.getTime() - new Date(record.check_in_at).getTime()) / 60000))
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
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
  const [busy, setBusy] = useState(false)
  const [todayRecords, setTodayRecords] = useState<AttendanceRecord[]>([])
  const [history, setHistory] = useState<AttendanceRecord[]>([])
  const [syncLogs, setSyncLogs] = useState<SyncLog[]>([])
  const [qrSession, setQrSession] = useState<QrSession | null>(null)
  const [resyncFrom, setResyncFrom] = useState(localDateKey())
  const [resyncTo, setResyncTo] = useState(localDateKey())
  const [lastMarked, setLastMarked] = useState<AttendanceRecord | null>(null)
  const [clock, setClock] = useState(new Date())

  const qrToken = useMemo(() => new URLSearchParams(window.location.search).get('qr'), [])

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
    loadData(profile).catch((error) => setNotice({ tone: 'error', text: error.message }))
  }, [profile, loadData])

  useEffect(() => {
    if (!profile || profile.role !== 'worker' || !qrToken || !supabase || !session) return
    setBusy(true)
    supabase.rpc('record_attendance_scan', { p_qr_token: qrToken })
      .then(({ data, error }) => {
        if (error) throw error
        setLastMarked(data as AttendanceRecord)
        setNotice({ tone: 'success', text: 'Marca registrada correctamente.' })
        window.history.replaceState({}, '', window.location.pathname)
        return loadData(profile)
      })
      .catch((error) => setNotice({ tone: 'error', text: error.message }))
      .finally(() => setBusy(false))
  }, [profile, qrToken, session, loadData])

  async function signIn(event: FormEvent) {
    event.preventDefault()
    if (!supabase) return
    setBusy(true)
    setNotice(null)
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    if (error) setNotice({ tone: 'error', text: 'No se pudo iniciar sesión. Revisa tu correo y contraseña.' })
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
      setQrSession(data as QrSession)
      setNotice({ tone: 'success', text: 'Código actualizado. El código anterior ya no funciona.' })
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
          {qrToken && <div className="inline-notice notice-info"><ShieldCheck size={17} /> QR leído. Inicia sesión para registrar tu marca.</div>}
          <form onSubmit={signIn} className="form-stack">
            <label>Correo electrónico<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="nombre@dkpartners.com" autoComplete="username" required /></label>
            <label>Contraseña<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Tu contraseña" autoComplete="current-password" required /></label>
            {notice && <Notice notice={notice} />}
            <button className="button button-primary button-wide" disabled={busy}>{busy ? 'Ingresando…' : 'Ingresar'} <ArrowRight size={17} /></button>
          </form>
          <p className="login-footnote"><ShieldCheck size={15} /> Acceso privado para el equipo DK Partners</p>
        </div>
        <div className="login-panel-footer">¿Necesitas acceso? Pídele una cuenta al administrador.</div>
      </section>
    </main>
  )

  if (!profile) return <div className="screen-center"><span className="loader" /> Preparando tu cuenta…</div>
  if (!profile.is_active) return <main className="screen-center"><div className="empty-state"><ShieldCheck size={28} /><h2>Cuenta desactivada</h2><p>Contacta al administrador de DK Partners.</p><button className="button button-secondary" onClick={signOut}>Cerrar sesión</button></div></main>

  const isAdmin = profile.role === 'admin'
  const ownRecord = todayRecords.find((record) => record.worker_id === profile.id)
  const displayDate = formatDate(clock, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand brand-dark"><span className="brand-mark">DK</span><span>DK PARTNERS</span></div>
        <div className="side-label">ESPACIO DE TRABAJO</div>
        <div className="side-nav-item active"><CalendarDays size={18} /><span>Asistencia</span></div>
        <div className="sidebar-bottom"><div className="sidebar-stamp">DK<span>·</span>26</div><span>CONTROL INTERNO</span></div>
      </aside>
      <section className="main-column">
        <header className="topbar">
          <div className="breadcrumb"><span>Equipo</span><span className="crumb-slash">/</span><strong>Asistencia</strong></div>
          <div className="topbar-user"><div className="avatar">{profile.full_name?.slice(0, 1).toUpperCase() || 'D'}</div><div className="user-copy"><strong>{profile.full_name}</strong><span>{isAdmin ? 'Administrador' : 'Trabajador'}</span></div><button className="icon-button" aria-label="Cerrar sesión" title="Cerrar sesión" onClick={signOut}><LogOut size={17} /></button></div>
        </header>
        <div className="page-content">
          <div className="page-heading"><div><span className="eyebrow">{isAdmin ? 'PANEL DE CONTROL' : 'MI ASISTENCIA'}</span><h1>{isAdmin ? 'Hola, ' : 'Hola, '}{profile.full_name?.split(' ')[0]}<span className="heading-period">.</span></h1><p>{displayDate}</p></div><div className="live-clock"><span className="live-dot" /> HORA DE PERÚ <strong>{formatDate(clock, { hour: 'numeric', minute: '2-digit' })}</strong></div></div>
          {notice && <Notice notice={notice} dismiss={() => setNotice(null)} />}

          {isAdmin ? (
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

function Notice({ notice, dismiss }: { notice: Notice; dismiss?: () => void }) {
  return <div className={`inline-notice notice-${notice.tone}`}><span>{notice.tone === 'success' ? <CheckCircle2 size={17} /> : notice.tone === 'error' ? <X size={17} /> : <ShieldCheck size={17} />}</span><span>{notice.text}</span>{dismiss && <button onClick={dismiss} aria-label="Cerrar aviso"><X size={15} /></button>}</div>
}

function SetupNotice() {
  return <main className="setup-page"><div className="setup-card"><div className="brand-mark">DK</div><span className="eyebrow">PRIMERA CONFIGURACIÓN</span><h1>Conecta el proyecto</h1><p>La interfaz ya está lista. Para guardar marcas de forma segura, agrega las credenciales públicas de tu proyecto Supabase en el archivo local <code>.env</code>.</p><pre>VITE_SUPABASE_URL=https://…supabase.co<br />VITE_SUPABASE_ANON_KEY=…</pre><p className="small-muted">Las credenciales privadas de Google Sheets y Supabase nunca van en este archivo del navegador.</p></div></main>
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
        <button className="button button-primary button-wide" onClick={onCreateQr} disabled={busy}><RefreshCw size={16} className={busy ? 'spin' : ''} /> {qrSession ? 'Renovar código QR' : 'Generar código QR'}</button>
        <div className="qr-note"><ShieldCheck size={14} /> Solo funciona para trabajadores con sesión iniciada</div>
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

function Metric({ icon, label, value, note, tone }: { icon: ReactNode; label: string; value: string; note: string; tone: string }) {
  return <article className="metric-card"><div className={`metric-icon tone-${tone}`}>{icon}</div><span className="metric-label">{label}</span><strong className="metric-value">{value}</strong><span className="metric-note">{note}</span><ArrowUpRight size={15} className="metric-arrow" /></article>
}

function WorkerDashboard({ record, history, lastMarked, busy, clock, onRefresh }: { record?: AttendanceRecord; history: AttendanceRecord[]; lastMarked: AttendanceRecord | null; busy: boolean; clock: Date; onRefresh: () => void }) {
  const hasStarted = Boolean(record?.check_in_at)
  const hasFinished = Boolean(record?.check_out_at)
  return <div className="worker-grid">
    <section className="panel worker-status-panel">
      <div className="panel-heading"><div><span className="eyebrow">MI JORNADA · {formatDate(clock, { day: '2-digit', month: 'short' }).toUpperCase()}</span><h2>Estado de hoy</h2></div><button className="icon-button icon-button-light" aria-label="Actualizar" onClick={onRefresh}><RefreshCw size={16} /></button></div>
      {lastMarked && <div className="mark-success"><CheckCircle2 size={19} /><div><strong>Marca registrada</strong><span>{lastMarked.check_out_at ? 'Salida' : 'Entrada'} · {formatTime(lastMarked.check_out_at || lastMarked.check_in_at)}</span></div></div>}
      <div className="work-summary"><div className="work-summary-icon"><Clock3 size={20} /></div><div><span>TIEMPO TRABAJADO</span><strong>{workedTime(record)}</strong></div><StatusPill record={record} /></div>
      <div className="timeline"><div className={`timeline-item ${hasStarted ? 'timeline-complete' : 'timeline-next'}`}><span className="timeline-marker">{hasStarted ? <Check size={13} /> : <ArrowDownToLine size={13} />}</span><div><span>ENTRADA</span><strong>{formatTime(record?.check_in_at)}</strong></div><small>{hasStarted ? 'Registrada' : 'Pendiente'}</small></div><div className="timeline-divider" /><div className={`timeline-item ${hasFinished ? 'timeline-complete' : hasStarted ? 'timeline-next' : ''}`}><span className="timeline-marker">{hasFinished ? <Check size={13} /> : <ArrowUpRight size={13} />}</span><div><span>SALIDA</span><strong>{formatTime(record?.check_out_at)}</strong></div><small>{hasFinished ? 'Registrada' : hasStarted ? 'Al volver a escanear' : 'Pendiente'}</small></div></div>
      <div className="scan-hint"><ShieldCheck size={16} /><p>Escanea el QR que muestra tu jefe para registrar {hasStarted ? 'tu salida' : 'tu entrada'}. Necesitas tener la sesión iniciada.</p></div>
      {busy && <div className="loading-line"><span className="loader loader-small" /> Procesando marca…</div>}
    </section>
    <section className="panel history-panel"><div className="panel-heading"><div><span className="eyebrow">TU REGISTRO</span><h2>Últimos días</h2></div><CalendarDays size={19} className="muted-icon" /></div><div className="history-list">{history.map((item) => <div className="history-item" key={item.id}><div className="history-day"><strong>{formatDate(new Date(`${item.work_date}T12:00:00`), { day: '2-digit' })}</strong><span>{formatDate(new Date(`${item.work_date}T12:00:00`), { month: 'short' }).replace('.', '')}</span></div><div className="history-date"><strong>{formatDate(new Date(`${item.work_date}T12:00:00`), { weekday: 'long' })}</strong><span>{formatTime(item.check_in_at)} — {formatTime(item.check_out_at)}</span></div><div className="history-hours">{workedTime(item)}</div></div>)}{history.length === 0 && <div className="history-empty">Tus marcas aparecerán aquí.</div>}</div><div className="history-foot"><span>Zona horaria</span><strong>Perú · UTC−5</strong></div></section>
  </div>
}

export default App
