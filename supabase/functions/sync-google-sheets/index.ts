import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-sync-secret',
}

type AttendanceRow = {
  id: string
  worker_id: string
  work_date: string
  check_in_at: string | null
  check_out_at: string | null
  worker: { full_name: string } | null
}

const headerRow = ['FECHA', 'TRABAJADOR', 'INGRESO', 'SALIDA', 'HORAS TRABAJADAS', 'ATTENDANCE_ID']

function base64Url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function textBase64Url(value: string) {
  return base64Url(new TextEncoder().encode(value))
}

function pemBytes(pem: string) {
  const body = pem.replace(/\\n/g, '\n').replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '')
  const binary = atob(body)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

async function googleAccessToken() {
  const email = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_EMAIL')
  const privateKey = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY')
  if (!email || !privateKey) throw new Error('Falta configurar la Service Account de Google en Supabase.')

  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${textBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${textBase64Url(JSON.stringify({
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }))}`
  const key = await crypto.subtle.importKey('pkcs8', pemBytes(privateKey), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned))
  const assertion = `${unsigned}.${base64Url(new Uint8Array(signature))}`
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  })
  const body = await response.json()
  if (!response.ok || !body.access_token) throw new Error(`Google no autorizó la sincronización (${response.status}).`)
  return body.access_token as string
}

function sheetsBase(spreadsheetId: string) {
  return `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`
}

function quotedTab(tab: string) {
  return `'${tab.replace(/'/g, "''")}'`
}

async function googleRequest(url: string, accessToken: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${accessToken}`)
  headers.set('content-type', 'application/json')
  const response = await fetch(url, {
    ...init,
    headers,
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Sheets API respondió ${response.status}: ${detail.slice(0, 500)}`)
  }
  return response.status === 204 ? null : await response.json()
}

async function ensureTab(spreadsheetId: string, tab: string, accessToken: string) {
  const info = await googleRequest(`${sheetsBase(spreadsheetId)}?fields=sheets.properties(sheetId,title)`, accessToken)
  const exists = (info.sheets ?? []).some((sheet: any) => sheet.properties?.title === tab)
  if (!exists) {
    await googleRequest(`${sheetsBase(spreadsheetId)}:batchUpdate`, accessToken, {
      method: 'POST',
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab } } }] }),
    })
  }
  const range = `${quotedTab(tab)}!A1:F1`
  const values = await googleRequest(`${sheetsBase(spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`, accessToken)
  if (!values.values?.length) {
    await googleRequest(`${sheetsBase(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, accessToken, {
      method: 'PUT', body: JSON.stringify({ values: [headerRow] }),
    })
  } else if (String(values.values[0]?.[5] ?? '').trim().toUpperCase() !== 'ATTENDANCE_ID') {
    throw new Error(`La pestaña “${tab}” ya existe, pero sus columnas no coinciden con el formato de sincronización.`)
  }
}

function formatDate(value: string) {
  const [year, month, day] = value.split('-')
  return `${day}/${month}/${year}`
}

function formatTime(value: string | null) {
  if (!value) return ''
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Lima', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(value))
}

function formatDuration(checkIn: string | null, checkOut: string | null) {
  if (!checkIn || !checkOut) return '0:00'
  const mins = Math.max(0, Math.floor((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 60000))
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`
}

async function upsertAttendance(spreadsheetId: string, tab: string, accessToken: string, attendance: AttendanceRow) {
  const range = `${quotedTab(tab)}!A:F`
  const result = await googleRequest(`${sheetsBase(spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`, accessToken)
  const rows = (result.values ?? []) as string[][]
  const idRowIndex = rows.findIndex((row, index) => index > 0 && row[5] === attendance.id)
  const values = [[
    formatDate(attendance.work_date),
    attendance.worker?.full_name ?? 'Trabajador',
    formatTime(attendance.check_in_at),
    formatTime(attendance.check_out_at),
    formatDuration(attendance.check_in_at, attendance.check_out_at),
    attendance.id,
  ]]

  if (idRowIndex >= 1) {
    const rowNumber = idRowIndex + 1
    const target = `${quotedTab(tab)}!A${rowNumber}:F${rowNumber}`
    await googleRequest(`${sheetsBase(spreadsheetId)}/values/${encodeURIComponent(target)}?valueInputOption=RAW`, accessToken, {
      method: 'PUT', body: JSON.stringify({ values }),
    })
  } else {
    await googleRequest(`${sheetsBase(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, accessToken, {
      method: 'POST', body: JSON.stringify({ values }),
    })
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const expectedSecret = Deno.env.get('SYNC_CRON_SECRET')
  if (!expectedSecret || request.headers.get('x-sync-secret') !== expectedSecret) {
    return Response.json({ error: 'No autorizado' }, { status: 401, headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  let serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!serviceKey) {
    try { serviceKey = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default } catch { serviceKey = undefined }
  }
  const spreadsheetId = Deno.env.get('GOOGLE_SHEETS_ID')
  const tab = Deno.env.get('GOOGLE_SHEETS_TAB') || 'Registro automático'
  if (!supabaseUrl || !serviceKey || !spreadsheetId) {
    return Response.json({ error: 'Falta configurar Supabase o GOOGLE_SHEETS_ID.' }, { status: 500, headers: corsHeaders })
  }

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  try {
    const { data: claims, error: claimError } = await db.rpc('claim_pending_sheet_syncs', { p_limit: 25 })
    if (claimError) throw claimError
    const ids = (claims ?? []).map((row: { attendance_id: string }) => row.attendance_id)
    if (!ids.length) return Response.json({ claimed: 0, synced: 0, failed: 0 }, { headers: corsHeaders })

    const { data: rows, error: rowsError } = await db.from('attendance_records')
      .select('id,worker_id,work_date,check_in_at,check_out_at,worker:profiles!attendance_records_worker_id_fkey(full_name)')
      .in('id', ids)
    if (rowsError) throw rowsError

    const accessToken = await googleAccessToken()
    await ensureTab(spreadsheetId, tab, accessToken)
    let synced = 0
    let failed = 0
    for (const attendance of (rows ?? []) as AttendanceRow[]) {
      try {
        await upsertAttendance(spreadsheetId, tab, accessToken, attendance)
        const { error } = await db.from('sync_log').update({ status: 'synced', error: null, updated_at: new Date().toISOString() }).eq('attendance_id', attendance.id)
        if (error) throw error
        synced += 1
      } catch (error) {
        failed += 1
        const message = error instanceof Error ? error.message.slice(0, 1000) : 'Error desconocido al sincronizar.'
        await db.from('sync_log').update({ status: 'error', error: message, updated_at: new Date().toISOString() }).eq('attendance_id', attendance.id)
      }
    }
    return Response.json({ claimed: ids.length, synced, failed }, { headers: corsHeaders })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error inesperado.'
    return Response.json({ error: message }, { status: 500, headers: corsHeaders })
  }
})
