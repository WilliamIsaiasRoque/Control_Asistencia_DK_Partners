# Control de asistencia · DK Partners

Aplicación web para un administrador y tres trabajadores. Supabase guarda los datos oficiales; Google Sheets recibe una copia de lectura para el equipo.

## Stack

- React + TypeScript + Vite para la interfaz.
- Supabase Auth y Postgres para cuentas, marcas y registro de sincronización.
- Supabase Edge Function + Google Sheets API para publicar filas de forma idempotente.
- Cloudflare Pages para servir el frontend estático en el plan gratuito.

## Primer arranque local

1. Instala Node.js LTS y Git.
2. Copia `.env.example` como `.env` y pega la URL y la clave pública (anon/publishable) del proyecto Supabase.
3. Desde la carpeta del repo ejecuta `npm install` y luego `npm run dev`.
4. Crea las cuentas desde Supabase Auth. El trigger crea automáticamente un perfil `worker`; después cambia el rol del jefe a `admin` desde el SQL Editor:

   ```sql
   update public.profiles
   set role = 'admin', full_name = 'Nombre del jefe'
   where id = (select id from auth.users where email = 'CORREO_DEL_JEFE');
   ```

5. Aplica la migración `supabase/migrations/202611070001_initial_schema.sql` antes de iniciar sesión.

La clave incluida en `.env` es pública y está restringida por RLS. No agregues claves privadas, JSON de Service Account ni secretos al frontend o a Git.

## Supabase

1. Crea un proyecto Supabase. El plan gratuito tiene límites y puede pausar proyectos con poca actividad.
2. Aplica la migración SQL.
3. Crea las cuentas del jefe y los trabajadores desde **Authentication → Users**. Usa el correo de cada persona y define su nombre en `raw_user_meta_data.full_name` o actualiza `profiles.full_name`.
4. Promueve solo la cuenta del jefe a `admin`; las cuentas nuevas quedan como `worker`.
5. Configura URL de redirección de Auth para el dominio local y el dominio de Cloudflare Pages.

## Google Sheets

La Edge Function usa una Service Account y Sheets API. Para las tres personas, las cuotas de Google son holgadas y la API estándar no agrega un cargo.

1. En Google Cloud crea un proyecto, habilita **Google Sheets API** y crea una Service Account.
2. Copia el correo de la Service Account y comparte el Google Sheet con ese correo como **Editor**. El equipo debe recibir acceso de **Lector**.
3. Guarda el ID del Sheet (el texto entre `/d/` y `/edit` en su enlace). No publiques el JSON descargado de la cuenta.
4. Configura estos secretos en el proyecto Supabase:

   ```text
   GOOGLE_SHEETS_ID=<id del spreadsheet>
   GOOGLE_SHEETS_TAB=Registro automático
   GOOGLE_SERVICE_ACCOUNT_EMAIL=<correo de la service account>
   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY=<private_key del JSON, incluyendo BEGIN/END>
   SYNC_CRON_SECRET=<cadena aleatoria larga>
   ```

   Ejemplo de despliegue de Edge Function: `supabase secrets set --env-file supabase/functions/.env` (no subas ese archivo a Git). `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` son valores internos del proyecto y nunca se colocan en el navegador.

5. En **Database → Extensions**, habilita `pg_cron`, `pg_net` y `supabase_vault`. Despliega `supabase/functions/sync-google-sheets` y aplica una sola vez `supabase/setup_cron.sql` en SQL Editor. Reemplaza los dos marcadores: URL de la función y el mismo valor de `SYNC_CRON_SECRET`. El cron revisa la cola cada cinco minutos.
6. La función crea una pestaña `Registro automático` si no existe. La tabla de esa pestaña es:

   | FECHA | TRABAJADOR | INGRESO | SALIDA | HORAS TRABAJADAS | ATTENDANCE_ID |
   |---|---|---|---|---|---|

   La última columna es una clave técnica estable y se puede ocultar. La función actualiza esa fila al recibir la salida y usa `ATTENDANCE_ID` para que los reintentos no dupliquen filas.

**Pendiente de adaptar a tu archivo:** todavía no se recibió el enlace del Sheet. Por eso la función crea una pestaña técnica con estructura normalizada. Cuando compartas el enlace, se puede conectar al diseño semanal existente (semana/día y grupos de columnas por trabajador) en lugar de dejar dos formatos distintos.

## QR y reglas de marcas

- El jefe genera un QR desde su panel. Renovarlo revoca el anterior; el actual vence a las 12 horas.
- Cada trabajador inicia sesión individualmente y escanea el QR con la cámara del teléfono. Si la sesión está cerrada, el enlace pide iniciar sesión y luego procesa el QR.
- Primer escaneo válido del día peruano registra entrada; el siguiente registra salida. Hay una pausa de 30 segundos para evitar que un doble toque cierre la jornada.
- Solo se permite una entrada y una salida por persona y fecha. Las correcciones manuales quedan reservadas para administrador.
- El QR demuestra que se conoce el código vigente; no verifica por sí solo la ubicación física. El jefe debe mostrarlo solo al equipo presente.

## Hojas de cálculo y recuperación

Cada día por trabajador tiene un `attendance_records.id` estable. El trigger SQL coloca ese ID en `sync_log`; fallos se guardan en `error`, `status` e `intentos`. La función reclama registros pendientes de manera atómica y los actualiza por ID. Si una ejecución se interrumpe, una fila `processing` vuelve a ser elegible después de diez minutos.

El botón del panel permite volver a poner un rango de fechas en la cola. Las marcas continúan guardándose en Supabase aunque Google no responda.

## Despliegue frontend

Conecta el repositorio a Cloudflare Pages usando:

- Comando de build: `npm run build`
- Carpeta de salida: `dist`
- Variables de build: `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY`

Cloudflare Pages gratuito sirve los archivos estáticos; este frontend no necesita guardar secretos de Google ni ejecutar lógica privilegiada.

## Historial desde noviembre de 2026

El Sheet actual tiene registros manuales. Para que Supabase sea la fuente de verdad, primero se debe decidir cuáles filas de noviembre se importan como historia y asociarlas con las cuentas correctas. Esa carga inicial es separada de la sincronización hacia delante y requiere el enlace del Sheet.
