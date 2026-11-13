# Control de asistencia · DK Partners

Aplicación web para un administrador y tres trabajadores. Supabase guarda los datos oficiales; Google Sheets recibe una copia de lectura para el equipo.

## Stack

- React + TypeScript + Vite para la interfaz.
- Supabase Auth y Postgres para cuentas, marcas y registro de sincronización.
- Supabase Edge Function + Google Sheets API para publicar filas de forma idempotente.
- Vercel para servir el frontend estático en el plan Hobby.

## Primer arranque local

1. Instala Node.js LTS y Git.
2. Copia `.env.example` como `.env` y pega la URL y la clave pública publishable del proyecto Supabase. Si el panel todavía muestra la clave legacy `anon`, también se acepta como `VITE_SUPABASE_ANON_KEY`.
3. Desde la carpeta del repo ejecuta `npm install` y luego `npm run dev`.
4. En Supabase SQL Editor, aplica los archivos de `supabase/migrations/` en orden. Si el proyecto ya está configurado, aplica las migraciones que aún no ejecutaste, en particular `202611100003_allow_checkin_after_empty_correction.sql` y `202611130001_location_based_attendance.sql`.
5. Crea las cuentas desde **Authentication → Users → Add user → Create new user** (no uses **Invite user**, que intenta enviar un correo). Asigna una contraseña temporal y confirma el correo desde el panel. El trigger crea automáticamente el perfil `worker`; cada persona puede cambiar su contraseña después de iniciar sesión desde **Cambiar contraseña**. Si alguien la olvida, el administrador le asigna otra desde Supabase.
6. Cambia el rol del jefe a `admin` desde el SQL Editor:

   ```sql
   update public.profiles
   set role = 'admin', full_name = 'Nombre del jefe'
   where id = (select id from auth.users where email = 'CORREO_DEL_JEFE');
   ```

Si la cuenta ya existe pero nunca llegó a tener contraseña, usa `scripts/set-auth-password.ps1` desde PowerShell para establecer una temporal mediante la API administrativa de Supabase. El script la solicita en pantalla segura y no guarda la Secret API key ni la contraseña en el repo. Nunca pegues esa clave en el frontend, Git o el chat.

Para pruebas locales, Vite usa el puerto fijo `5174`. Configura **Authentication → URL Configuration** con `http://localhost:5174` como Site URL y agrega `http://localhost:5174/**` a Redirect URLs. Este flujo no necesita SMTP ni correos de invitación; el equipo entra con las contraseñas temporales creadas por el admin y puede cambiarlas dentro de la app.

La clave incluida en `.env` es pública y está restringida por RLS. No agregues claves privadas, JSON de Service Account ni secretos al frontend o a Git.

## Supabase

1. Crea un proyecto Supabase. El plan gratuito tiene límites y puede pausar proyectos con poca actividad.
2. Aplica la migración SQL.
3. Crea las cuentas del jefe y los trabajadores desde **Authentication → Users → Add user → Create new user** (no **Invite user**). Asigna contraseña temporal y confirma cada correo desde el panel. Define los nombres en `profiles.full_name`.
4. Promueve solo la cuenta del jefe a `admin`; las cuentas nuevas quedan como `worker`.
5. Configura URL de redirección de Auth para el dominio local y el dominio de Vercel.

## Google Sheets

La sincronización utiliza **Google Apps Script Web App** para no depender de una cuenta de facturación de Google Cloud. Supabase sigue siendo la fuente oficial; la hoja es una copia de consulta. La app escribe en el formato semanal existente: https://docs.google.com/spreadsheets/d/1qtxU2ZZEraO4h07jq0SD3mXlUhCMcltmuIhxw7sOetE/edit

La hoja debe conservar sus pestañas mensuales (`NOVIEMBRE`, `DICIEMBRE`, etc.), los nombres de trabajadores en la fila 1 y `Día`, `Fecha` e `Ingreso`/`Salida`/`Horas` en la fila 2. Las fechas deben ser valores de fecha reales. El script solo modifica Ingreso y Salida; las fórmulas existentes calculan Horas y totales. El formato de hora es `h:mm AM/PM`. Para que los totales semanales acumulen correctamente más de 24 horas, aplica a las celdas de total semanal el formato Duración o el formato personalizado `[h]:mm`. La pestaña oculta `_SYNC_IDS` guarda el UUID de Supabase para reintentar sin duplicados.

### Configuración

1. Abre el Sheet con la cuenta admin, ve a **Extensiones → Apps Script** y pega `google-apps-script/Code.gs` en `Code.gs`.
2. En **Project Settings → Script Properties**, añade `SPREADSHEET_ID` (el ID entre `/d/` y `/edit`) y `WEBHOOK_SECRET` (una cadena aleatoria larga).
3. En **Deploy → New deployment → Web app**, selecciona **Execute as me** y el acceso **Anyone**. La URL `/exec` es el webhook; el secreto del paso anterior protege la escritura. El script corre con acceso a la hoja de la cuenta admin.
4. Guarda estos secretos en **Supabase → Edge Functions → Secrets**: `APPS_SCRIPT_WEBHOOK_URL` (URL `/exec`), `APPS_SCRIPT_WEBHOOK_SECRET` (el mismo `WEBHOOK_SECRET`) y `SYNC_CRON_SECRET` (otro secreto aleatorio). No pongas secretos en el frontend, en la hoja ni en Git.
5. Desde PowerShell, en el repo, ejecuta `supabase login`, `supabase link --project-ref evnfjzomveojmxbvyeav` y `supabase functions deploy sync-google-sheets`. Habilita `pg_cron`, `pg_net` y Vault. En `supabase/setup_cron.sql`, reemplaza el URL de ejemplo con `https://evnfjzomveojmxbvyeav.supabase.co/functions/v1/sync-google-sheets` y el marcador del secreto con `SYNC_CRON_SECRET`; ejecuta el SQL una vez.
6. Registra una entrada de prueba. El cron la procesa dentro de cinco minutos. En el panel admin revisa el estado; ante errores, `sync_log` guarda el mensaje y los intentos, y reintenta automáticamente. El botón **Re-sincronizar con Google Sheets** permite volver a poner un rango en cola.

El Sheet debe compartirse con los trabajadores como **Lector**. La cuenta de Apps Script admin no necesita compartir una credencial con Google Cloud ni crear una Service Account. Apps Script tiene cuotas diarias gratuitas, suficientes para este equipo; Google puede cambiarlas.
## Marcación con ubicación

- El trabajador inicia sesión y pulsa **Marcar entrada** o **Marcar salida**. Tras confirmar, el navegador pide permiso de ubicación; Supabase acepta la marca solo si el dispositivo informa precisión suficiente y está dentro del radio permitido.
- La app solicita ubicación únicamente al marcar. No rastrea al trabajador continuamente. Cada intento aceptado registra coordenadas, precisión y distancia en `attendance_location_events`, con lectura limitada al trabajador y al administrador.
- Después de aplicar `202611130001_location_based_attendance.sql`, abre la app desplegada como administrador, desde un teléfono físicamente en la tienda, entra en **Administración → Ubicación del local**, pulsa **Usar mi ubicación actual** y luego **Guardar ubicación**. Empieza con radio de 150 m y precisión máxima de 150 m; prueba en los teléfonos del equipo y ajusta el radio si el GPS del local lo necesita.
- Permite ubicación para el sitio y activa los servicios de ubicación del teléfono. Geolocation requiere HTTPS; Vercel lo sirve por HTTPS. Conviene configurar el punto y marcar desde teléfonos, porque algunas computadoras no tienen GPS preciso.
- El administrador puede actualizar el punto desde esa sección. Las correcciones manuales siguen disponibles en **Corregir asistencia** y también se sincronizan con Google Sheets.
- La migración deshabilita las funciones de marca antiguas por QR y clave corta para que no eviten la validación de ubicación. Los enlaces viejos `?qr=...` se limpian de la barra y no generan una marca.

## Hojas de cálculo y recuperación

Cada día por trabajador tiene un `attendance_records.id` estable. El trigger SQL coloca ese ID en `sync_log`; fallos se guardan en `error`, `status` e `intentos`. La función reclama registros pendientes de manera atómica y los actualiza por ID. Si una ejecución se interrumpe, una fila `processing` vuelve a ser elegible después de diez minutos.

El botón del panel permite volver a poner un rango de fechas en la cola. Las marcas continúan guardándose en Supabase aunque Google no responda.

## Despliegue frontend

Conecta el repositorio a Vercel usando:

- Comando de build: `npm run build`
- Carpeta de salida: `dist`
- Variables de build: `VITE_SUPABASE_URL` y `VITE_SUPABASE_PUBLISHABLE_KEY`

Vercel Hobby sirve los archivos estáticos; este frontend no necesita guardar secretos de Google ni ejecutar lógica privilegiada. Configura esas variables para Production y Preview y vuelve a desplegar.

## Historial desde noviembre de 2026

El Sheet actual tiene registros manuales. Para que Supabase sea la fuente de verdad, primero se debe decidir cuáles filas de noviembre se importan como historia y asociarlas con las cuentas correctas. Esa carga inicial es separada de la sincronización hacia delante y requiere el enlace del Sheet.
