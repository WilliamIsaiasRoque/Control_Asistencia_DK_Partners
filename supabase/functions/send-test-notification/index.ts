import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-test-secret',
}

type ServiceAccount = {
  client_email: string
  private_key: string
  project_id: string
}

type PushDevice = { id: string; fcm_token: string }

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

async function sendToDevice(projectId: string, accessToken: string, token: string) {
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
  const responseBody = await response.text()
  return { ok: response.ok, status: response.status, body: responseBody }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') {
    return Response.json({ error: 'Método no permitido.' }, { status: 405, headers: corsHeaders })
  }

  const expectedSecret = Deno.env.get('TEST_PUSH_SECRET')
  if (!expectedSecret || request.headers.get('x-test-secret') !== expectedSecret) {
    return Response.json({ error: 'No autorizado.' }, { status: 401, headers: corsHeaders })
  }

  let userId: string | undefined
  try {
    const body = await request.json() as { user_id?: unknown }
    if (typeof body.user_id === 'string') userId = body.user_id
  } catch {
    return Response.json({ error: 'Envía un JSON válido.' }, { status: 400, headers: corsHeaders })
  }
  if (!userId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    return Response.json({ error: 'Indica un user_id válido para la prueba.' }, { status: 400, headers: corsHeaders })
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
    return Response.json({ error: 'Falta configurar los secretos de envío.' }, { status: 500, headers: corsHeaders })
  }

  let account: ServiceAccount
  try {
    account = JSON.parse(serviceAccountJson) as ServiceAccount
    if (!account.client_email || !account.private_key || !account.project_id) throw new Error()
  } catch {
    return Response.json({ error: 'FCM_SERVICE_ACCOUNT_JSON no es un JSON de cuenta de servicio válido.' }, { status: 500, headers: corsHeaders })
  }

  const db = createClient(serviceUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  try {
    const { data, error } = await db.from('push_devices')
      .select('id,fcm_token')
      .eq('user_id', userId)
      .eq('is_active', true)
    if (error) throw error
    const devices = (data ?? []) as PushDevice[]
    if (!devices.length) {
      return Response.json({ sent: 0, failed: 0, message: 'La cuenta no tiene dispositivos activos.' }, { headers: corsHeaders })
    }

    const accessToken = await createFirebaseAccessToken(account)
    let sent = 0
    let failed = 0
    for (const device of devices) {
      const result = await sendToDevice(account.project_id, accessToken, device.fcm_token)
      if (result.ok) {
        sent += 1
      } else {
        failed += 1
        if (result.status === 404 || result.body.includes('UNREGISTERED')) {
          await db.from('push_devices').update({ is_active: false, updated_at: new Date().toISOString() })
            .eq('id', device.id)
        }
        console.error(`FCM falló para un dispositivo (HTTP ${result.status}).`)
      }
    }

    return Response.json({ sent, failed, total: devices.length }, { headers: corsHeaders })
  } catch (error) {
    console.error('Error al enviar prueba FCM:', error instanceof Error ? error.message : 'error desconocido')
    return Response.json({ error: 'No se pudo enviar la notificación de prueba.' }, { status: 500, headers: corsHeaders })
  }
})
