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
  worker: { full_name: string } | { full_name: string }[] | null
}

type AppsScriptResult = { attendance_id: string; ok: boolean; error?: string }

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Error desconocido al sincronizar.'
}

async function markSync(db: ReturnType<typeof createClient>, attendanceId: string, status: 'synced' | 'error', error: string | null) {
  const { error: updateError } = await db.from('sync_log').update({
    status,
    error,
    updated_at: new Date().toISOString(),
  }).eq('attendance_id', attendanceId)
  if (updateError) throw updateError
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
  const appsScriptUrl = Deno.env.get('APPS_SCRIPT_WEBHOOK_URL')
  const appsScriptSecret = Deno.env.get('APPS_SCRIPT_WEBHOOK_SECRET')
  if (!supabaseUrl || !serviceKey || !appsScriptUrl || !appsScriptSecret) {
    return Response.json({ error: 'Falta configurar la conexión Supabase o Apps Script.' }, { status: 500, headers: corsHeaders })
  }

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  let claimedIds: string[] = []
  try {
    const { data: claims, error: claimError } = await db.rpc('claim_pending_sheet_syncs', { p_limit: 25 })
    if (claimError) throw claimError
    const ids = (claims ?? []).map((row: { attendance_id: string }) => row.attendance_id)
    claimedIds = ids
    if (!ids.length) return Response.json({ claimed: 0, synced: 0, failed: 0 }, { headers: corsHeaders })

    const { data: rows, error: rowsError } = await db.from('attendance_records')
      .select('id,worker_id,work_date,check_in_at,check_out_at,worker:profiles!attendance_records_worker_id_fkey(full_name)')
      .in('id', ids)
    if (rowsError) throw rowsError

    const items = ((rows ?? []) as AttendanceRow[]).map((row) => {
      const worker = Array.isArray(row.worker) ? row.worker[0] : row.worker
      return {
        id: row.id,
        worker_id: row.worker_id,
        worker_name: worker?.full_name ?? '',
        work_date: row.work_date,
        check_in_at: row.check_in_at,
        check_out_at: row.check_out_at,
      }
    })
    const response = await fetch(appsScriptUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: appsScriptSecret, items }),
      redirect: 'follow',
    })
    const responseText = await response.text()
    let result: { ok?: boolean; error?: string; results?: AppsScriptResult[] }
    try { result = JSON.parse(responseText) } catch { throw new Error(`Apps Script devolvió una respuesta no válida (${response.status}).`) }
    if (!response.ok || !result.ok || !Array.isArray(result.results)) {
      throw new Error(result.error || `Apps Script respondió ${response.status}.`)
    }

    const outcomes = new Map(result.results.map((item) => [item.attendance_id, item]))
    let synced = 0
    let failed = 0
    for (const id of ids) {
      const outcome = outcomes.get(id)
      try {
        if (outcome?.ok) {
          await markSync(db, id, 'synced', null)
          synced += 1
        } else {
          await markSync(db, id, 'error', (outcome?.error || 'Apps Script no devolvió el resultado de esta marca.').slice(0, 1000))
          failed += 1
        }
      } catch (error) {
        failed += 1
        console.error(`No se pudo actualizar sync_log para ${id}: ${errorMessage(error)}`)
      }
    }
    return Response.json({ claimed: ids.length, synced, failed }, { headers: corsHeaders })
  } catch (error) {
    const message = errorMessage(error).slice(0, 1000)
    for (const id of claimedIds) {
      try { await markSync(db, id, 'error', message) } catch (updateError) {
        console.error(`No se pudo marcar como error ${id}: ${errorMessage(updateError)}`)
      }
    }
    return Response.json({ error: message }, { status: 500, headers: corsHeaders })
  }
})
