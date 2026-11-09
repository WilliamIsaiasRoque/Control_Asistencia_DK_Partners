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

const syncIndexTab = '_SYNC_IDS'
const monthTabs = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE']
const syncIndexHeaders = ['ATTENDANCE_ID', 'WORKER_ID', 'WORK_DATE', 'SHEET_TAB', 'ROW', 'ENTRY_COLUMN', 'EXIT_COLUMN']

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

async function sheetValues(spreadsheetId: string, range: string, accessToken: string, valueRenderOption = 'UNFORMATTED_VALUE') {
  return await googleRequest(
    `${sheetsBase(spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=${valueRenderOption}`,
    accessToken,
  )
}

async function writeSheetValues(spreadsheetId: string, accessToken: string, data: Array<{ range: string; values: unknown[][] }>) {
  if (!data.length) return
  await googleRequest(`${sheetsBase(spreadsheetId)}/values:batchUpdate`, accessToken, {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
  })
}

async function ensureSyncIndex(spreadsheetId: string, accessToken: string) {
  let info = await googleRequest(`${sheetsBase(spreadsheetId)}?fields=sheets.properties(sheetId,title,hidden)`, accessToken)
  let indexSheet = (info.sheets ?? []).find((sheet: any) => sheet.properties?.title === syncIndexTab)
  if (!indexSheet) {
    await googleRequest(`${sheetsBase(spreadsheetId)}:batchUpdate`, accessToken, {
      method: 'POST',
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: syncIndexTab, hidden: true, gridProperties: { hideGridlines: true } } } }] }),
    })
    info = await googleRequest(`${sheetsBase(spreadsheetId)}?fields=sheets.properties(sheetId,title,hidden)`, accessToken)
    indexSheet = (info.sheets ?? []).find((sheet: any) => sheet.properties?.title === syncIndexTab)
  }
  if (!indexSheet) throw new Error('No se pudo preparar la pestaña técnica de sincronización.')

  const headerRange = `${quotedTab(syncIndexTab)}!A1:G1`
  const headers = await sheetValues(spreadsheetId, headerRange, accessToken, 'FORMATTED_VALUE')
  if (!headers.values?.length) {
    await writeSheetValues(spreadsheetId, accessToken, [{ range: headerRange, values: [syncIndexHeaders] }])
  } else if (syncIndexHeaders.some((header, index) => String(headers.values[0]?.[index] ?? '').trim().toUpperCase() !== header)) {
    throw new Error(`La pestaña oculta “${syncIndexTab}” existe, pero su estructura no coincide con el índice de sincronización.`)
  }
}

function tabForWorkDate(value: string) {
  const month = Number(value.split('-')[1])
  const tab = monthTabs[month - 1]
  if (!tab) throw new Error(`La fecha de asistencia “${value}” no es válida.`)
  return tab
}

function dateToSheetSerial(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000) + 25569
}

function sheetCellDateSerial(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value)
  if (typeof value === 'string') {
    const match = value.trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
    if (match) return dateToSheetSerial(`${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`)
  }
  return null
}

function normalizeName(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function namesMatch(profileName: string, headerName: string) {
  const profile = normalizeName(profileName)
  const header = normalizeName(headerName)
  return Boolean(profile && header && Math.min(profile.length, header.length) >= 3 && (profile === header || profile.startsWith(header) || header.startsWith(profile)))
}

function columnLetters(index: number) {
  let current = index + 1
  let result = ''
  while (current > 0) {
    const remainder = (current - 1) % 26
    result = String.fromCharCode(65 + remainder) + result
    current = Math.floor((current - 1) / 26)
  }
  return result
}

async function locateAttendanceCells(spreadsheetId: string, tab: string, accessToken: string, attendance: AttendanceRow) {
  const range = `${quotedTab(tab)}!A1:Z100`
  const result = await sheetValues(spreadsheetId, range, accessToken)
  const rows = (result.values ?? []) as unknown[][]
  const headers = rows[0] ?? []
  const subheaders = rows[1] ?? []
  const dateColumn = subheaders.findIndex((value) => normalizeName(String(value ?? '')) === 'FECHA')
  if (dateColumn < 0) throw new Error(`No encuentro la columna “Fecha” en las primeras filas de la pestaña “${tab}”.`)

  const dateSerial = dateToSheetSerial(attendance.work_date)
  const rowIndex = rows.findIndex((row, index) => index >= 2 && sheetCellDateSerial(row[dateColumn]) === dateSerial)
  if (rowIndex < 0) throw new Error(`No existe una fila para ${attendance.work_date} en la pestaña “${tab}”.`)

  const blockStart = headers.findIndex((value, index) => index > dateColumn && namesMatch(attendance.worker?.full_name ?? '', String(value ?? '')))
  if (blockStart < 0) throw new Error(`No encuentro un bloque para “${attendance.worker?.full_name ?? 'Trabajador'}” en la fila 1 de “${tab}”. Revisa el nombre del perfil.`)

  const entryColumn = subheaders.findIndex((value, index) => index >= blockStart && normalizeName(String(value ?? '')) === 'INGRESO')
  const exitColumn = subheaders.findIndex((value, index) => index > entryColumn && normalizeName(String(value ?? '')) === 'SALIDA')
  if (entryColumn < blockStart || exitColumn <= entryColumn || exitColumn > blockStart + 3) {
    throw new Error(`No están las columnas “Ingreso” y “Salida” junto al bloque de “${attendance.worker?.full_name ?? 'Trabajador'}” en “${tab}”.`)
  }

  return { rowNumber: rowIndex + 1, entryColumn, exitColumn }
}

function formatTime(value: string | null) {
  if (!value) return ''
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Lima', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(value))
}

async function upsertAttendance(spreadsheetId: string, tab: string, accessToken: string, attendance: AttendanceRow, indexRows: unknown[][]) {
  const targetTab = tabForWorkDate(attendance.work_date)
  if (tab !== targetTab) throw new Error(`La marca ${attendance.work_date} debe ir en la pestaña “${targetTab}”, no en “${tab}”.`)
  const knownIndex = indexRows.findIndex((row) => String(row[0] ?? '') === attendance.id)
  const mapped = knownIndex >= 0 ? indexRows[knownIndex] : null
  const located = mapped && String(mapped[3] ?? '') === tab
    ? { rowNumber: Number(mapped[4]), entryColumn: Number(mapped[5]), exitColumn: Number(mapped[6]) }
    : await locateAttendanceCells(spreadsheetId, tab, accessToken, attendance)

  const rowNumber = located.rowNumber
  if (!Number.isInteger(rowNumber) || rowNumber < 3 || !Number.isInteger(located.entryColumn) || !Number.isInteger(located.exitColumn)) {
    throw new Error(`El índice de sincronización de ${attendance.id} contiene una ubicación inválida.`)
  }

  const data: Array<{ range: string; values: unknown[][] }> = []
  if (attendance.check_in_at) {
    data.push({ range: `${quotedTab(tab)}!${columnLetters(located.entryColumn)}${rowNumber}`, values: [[formatTime(attendance.check_in_at)]] })
  }
  if (attendance.check_out_at) {
    data.push({ range: `${quotedTab(tab)}!${columnLetters(located.exitColumn)}${rowNumber}`, values: [[formatTime(attendance.check_out_at)]] })
  }
  await writeSheetValues(spreadsheetId, accessToken, data)

  const indexRow = [attendance.id, attendance.worker_id, attendance.work_date, tab, rowNumber, located.entryColumn, located.exitColumn]
  if (knownIndex >= 0) {
    const indexRowNumber = knownIndex + 2
    await writeSheetValues(spreadsheetId, accessToken, [{ range: `${quotedTab(syncIndexTab)}!A${indexRowNumber}:G${indexRowNumber}`, values: [indexRow] }])
  } else {
    const current = await sheetValues(spreadsheetId, `${quotedTab(syncIndexTab)}!A:A`, accessToken, 'UNFORMATTED_VALUE')
    const indexRowNumber = Math.max(2, (current.values?.length ?? 1) + 1)
    await writeSheetValues(spreadsheetId, accessToken, [{ range: `${quotedTab(syncIndexTab)}!A${indexRowNumber}:G${indexRowNumber}`, values: [indexRow] }])
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
    await ensureSyncIndex(spreadsheetId, accessToken)
    const indexResult = await sheetValues(spreadsheetId, `${quotedTab(syncIndexTab)}!A2:G`, accessToken)
    const indexRows = (indexResult.values ?? []) as unknown[][]
    let synced = 0
    let failed = 0
    for (const attendance of (rows ?? []) as AttendanceRow[]) {
      try {
        const tab = tabForWorkDate(attendance.work_date)
        await upsertAttendance(spreadsheetId, tab, accessToken, attendance, indexRows)
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
