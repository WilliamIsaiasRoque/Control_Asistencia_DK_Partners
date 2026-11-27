import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-reminder-secret',
}

type ServiceAccount = {
  client_email: string
  private_key: string
  project_id: string
}

type AttendanceRow = { worker_id: string }
type ActiveProfile = { id: string }
type PushDevice = { id: string; user_id: string; fcm_token: string }

const reminderSlots = new Set(['17:00', '17:20', '17:40', '18:00', '18:20'])

function errorLogFields(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message.slice(0, 800) }
  }
  if (typeof error === 'object' && error !== null) {
    const value = error as Record<string, unknown>
    const safeText = (field: string) =>
      typeof value[field] === 'string' ? (value[field] as string).slice(0, 800) : undefined
    return {
      name: 'SupabaseError',
      code: safeText('code'),
      message: safeText('message'),
      details: safeText('details'),
      hint: safeText('hint'),
    }
  }
  return { name: typeof error, message: String(error).slice(0, 800) }
}

function encodeBase64Url(value: string | Uint8Array) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function decodePrivateKey(pem: string) {
  const encoded = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '')
  const binary = atob(encoded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

async function createFirebaseAccessToken(account: ServiceAccount) {
  const now = Math.floor(Date.now() / 1000)
  const header = encodeBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = encodeBase64Url(JSON.stringify({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }))
  const unsignedJwt = `${header}.${claims}`
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    decodePrivateKey(account.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(unsignedJwt),
  )
  const assertion = `${unsignedJwt}.${encodeBase64Url(new Uint8Array(signature))}`
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  })
  if (!response.ok) throw new Error('Firebase rechazó las credenciales de servidor.')
  const result = await response.json() as { access_token?: string }
  if (!result.access_token) throw new Error('Firebase no entregó un token de acceso.')
  return result.access_token
}

async function sendReminder(projectId: string, accessToken: string, token: string) {
  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token,
          notification: {
            title: 'Asistencia pendiente',
            body: 'Aún no registras tu hora de salida. Recuerda marcarla al terminar tu jornada.',
          },
          android: {
            priority: 'HIGH',
            notification: { sound: 'default' },
          },
          apns: {
            headers: { 'apns-priority': '10' },
            payload: { aps: { sound: 'default' } },
          },
        },
      }),
    },
  )
  const body = await response.text()
  let errorMessage = `FCM respondió HTTP ${response.status}.`
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } }
    if (parsed.error?.message) errorMessage = parsed.error.message.slice(0, 1000)
  } catch { /* keep generic status */ }
  return { ok: response.ok, status: response.status, body, errorMessage }
}

function limaDateAndTime(now: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return {
    workDate: `${value('year')}-${value('month')}-${value('day')}`,
    time: `${value('hour')}:${value('minute')}`,
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') {
    return Response.json({ error: 'Método no permitido.' }, { status: 405, headers: corsHeaders })
  }

  const expectedSecret = Deno.env.get('REMINDER_CRON_SECRET')
  if (!expectedSecret || request.headers.get('x-reminder-secret') !== expectedSecret) {
    return Response.json({ error: 'No autorizado.' }, { status: 401, headers: corsHeaders })
  }

  const { workDate, time } = limaDateAndTime(new Date())
  if (!reminderSlots.has(time)) {
    return Response.json({ skipped: true, reason: 'outside_reminder_slots', lima_time: time }, { headers: corsHeaders })
  }

  const serviceUrl = Deno.env.get('SUPABASE_URL')
  let serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!serviceKey) {
    try {
      serviceKey = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default
    } catch {
      serviceKey = undefined
    }
  }
  const serviceAccountJson = Deno.env.get('FCM_SERVICE_ACCOUNT_JSON')
  if (!serviceUrl || !serviceKey || !serviceAccountJson) {
    console.error(JSON.stringify({
      event: 'send-attendance-reminders missing secrets',
      work_date: workDate,
      slot: time,
      service_url_configured: Boolean(serviceUrl),
      service_key_configured: Boolean(serviceKey),
      fcm_service_account_configured: Boolean(serviceAccountJson),
    }))
    return Response.json({ error: 'Falta configurar los secretos de envío.' }, { status: 500, headers: corsHeaders })
  }

  let account: ServiceAccount
  try {
    account = JSON.parse(serviceAccountJson) as ServiceAccount
    if (!account.client_email || !account.private_key || !account.project_id) throw new Error()
  } catch (error) {
    console.error(JSON.stringify({
      event: 'send-attendance-reminders invalid FCM service account',
      work_date: workDate,
      slot: time,
      error: errorLogFields(error),
    }))
    return Response.json({ error: 'FCM_SERVICE_ACCOUNT_JSON no es válido.' }, { status: 500, headers: corsHeaders })
  }

  const db = createClient(serviceUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  let stage = 'consultar asistencias pendientes'
  try {
    const { data: attendanceRows, error: attendanceError } = await db
      .from('attendance_records')
      .select('worker_id')
      .eq('work_date', workDate)
      .not('check_in_at', 'is', null)
      .is('check_out_at', null)
    if (attendanceError) throw attendanceError
    const userIds = [...new Set(((attendanceRows ?? []) as AttendanceRow[]).map((row) => row.worker_id))]
    if (!userIds.length) {
      console.info(JSON.stringify({
        event: 'send-attendance-reminders no pending attendance',
        work_date: workDate,
        slot: time,
        sent: 0,
        failed: 0,
      }))
      return Response.json({ slot: time, eligible_users: 0, sent: 0, failed: 0 }, { headers: corsHeaders })
    }

    stage = 'consultar perfiles activos'
    const { data: profiles, error: profilesError } = await db.from('profiles')
      .select('id')
      .eq('is_active', true)
      .in('id', userIds)
    if (profilesError) throw profilesError
    const activeUserIds = ((profiles ?? []) as ActiveProfile[]).map((profile) => profile.id)
    if (!activeUserIds.length) {
      console.info(JSON.stringify({
        event: 'send-attendance-reminders no active profiles',
        work_date: workDate,
        slot: time,
        attendance_users: userIds.length,
        sent: 0,
        failed: 0,
      }))
      return Response.json({ slot: time, eligible_users: 0, sent: 0, failed: 0 }, { headers: corsHeaders })
    }

    stage = 'consultar dispositivos activos'
    const { data: devices, error: devicesError } = await db.from('push_devices')
      .select('id,user_id,fcm_token')
      .eq('is_active', true)
      .in('user_id', activeUserIds)
    if (devicesError) throw devicesError
    const activeDevices = (devices ?? []) as PushDevice[]
    if (!activeDevices.length) {
      console.info(JSON.stringify({
        event: 'send-attendance-reminders no active devices',
        work_date: workDate,
        slot: time,
        eligible_users: activeUserIds.length,
        devices: 0,
        sent: 0,
        failed: 0,
      }))
      return Response.json({ slot: time, eligible_users: activeUserIds.length, sent: 0, failed: 0 }, { headers: corsHeaders })
    }

    stage = 'autenticar con Firebase'
    const accessToken = await createFirebaseAccessToken(account)
    let sent = 0
    let failed = 0
    let skipped = 0
    for (const device of activeDevices) {
      stage = 'reservar recordatorio'
      const { data: deliveryId, error: claimError } = await db.rpc('claim_attendance_reminder', {
        p_device_id: device.id,
        p_work_date: workDate,
        p_reminder_slot: `${time}:00`,
      })
      if (claimError) throw claimError
      if (typeof deliveryId !== 'string') {
        skipped += 1
        continue
      }

      stage = 'enviar notificación a Firebase'
      const result = await sendReminder(account.project_id, accessToken, device.fcm_token)
      const now = new Date().toISOString()
      if (result.ok) {
        stage = 'guardar resultado del envío'
        const { error: updateError } = await db.from('attendance_reminder_deliveries')
          .update({ status: 'sent', sent_at: now, last_error: null, updated_at: now })
          .eq('id', deliveryId)
        if (updateError) throw updateError
        sent += 1
      } else {
        stage = 'guardar error del envío'
        const { error: updateError } = await db.from('attendance_reminder_deliveries')
          .update({ status: 'failed', last_error: result.errorMessage, updated_at: now })
          .eq('id', deliveryId)
        if (updateError) throw updateError
        if (result.status === 404 || result.body.includes('UNREGISTERED')) {
          await db.from('push_devices')
            .update({ is_active: false, updated_at: now })
            .eq('id', device.id)
        }
        console.error(`No se pudo enviar un aviso (HTTP ${result.status}).`)
        failed += 1
      }
    }

    const summary = {
      work_date: workDate,
      slot: time,
      eligible_users: activeUserIds.length,
      devices: activeDevices.length,
      sent,
      failed,
      skipped,
    }
    console.info(JSON.stringify({ event: 'send-attendance-reminders completed', ...summary }))
    return Response.json(summary, { headers: corsHeaders })
  } catch (error) {
    console.error(JSON.stringify({
      event: 'send-attendance-reminders failed',
      work_date: workDate,
      slot: time,
      stage,
      error: errorLogFields(error),
    }))
    return Response.json({ error: 'No se pudieron procesar los recordatorios.' }, { status: 500, headers: corsHeaders })
  }
})
