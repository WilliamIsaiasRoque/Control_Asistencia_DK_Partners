# Control de asistencia · DK Partners

Aplicación web para un administrador y tres trabajadores. Supabase guarda los datos oficiales; Google Sheets recibe una copia de lectura para el equipo.

## Stack

- React + TypeScript + Vite para la interfaz.
- Supabase Auth y Postgres para cuentas, marcas y registro de sincronización.
- Supabase Edge Function + Google Sheets API para publicar filas de forma idempotente.
- Cloudflare Pages para servir el frontend estático en el plan gratuito.

## Primer arranque local

1. Instala Node.js LTS y Git.
2. Copia `.env.example` como `.env` y pega la URL y la clave pública publishable del proyecto Supabase. Si el panel todavía muestra la clave legacy `anon`, también se acepta como `VITE_SUPABASE_ANON_KEY`.
3. Desde la carpeta del repo ejecuta `npm install` y luego `npm run dev`.
4. Aplica la migración `supabase/migrations/202611070001_initial_schema.sql` y luego `supabase/migrations/202611090002_attendance_short_code.sql` y `supabase/migrations/202611090003_restore_active_attendance_session.sql`.
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
5. Configura URL de redirección de Auth para el dominio local y el dominio de Cloudflare Pages.

## Google Sheets

La app sincroniza hacia el formato semanal existente de Google Sheets. Supabase sigue siendo la fuente oficial; los datos del Sheet son una copia de consulta. La hoja compartida es: https://docs.google.com/spreadsheets/d/1qtxU2ZZEraO4h07jq0SD3mXlUhCMcltmuIhxw7sOetE/edit

Cada pestaña mensual debe conservar este diseño:

- Fila 1: nombre del trabajador sobre su bloque de columnas.
- Fila 2: `Día`, `Fecha` y, para cada trabajador, `Ingreso`, `Salida`, `Horas`.
- Filas siguientes: una fila por fecha. La app solo actualiza Ingreso y Salida; las fórmulas existentes calculan Horas y totales.
- Formato horario de las columnas Ingreso/Salida: `h:mm AM/PM`. En las pestañas actuales, las columnas son D:E para William, H:I para Rommel y L:M para Shantal. Se corrigió el formato de la marca de 14:15 para mostrar 2:15 PM.
- La pestaña oculta `_SYNC_IDS` guarda el UUID de Supabase y la ubicación de la fila, para reintentar sin duplicar.

Para habilitar el flujo automático, todavía hay que completar la configuración en Supabase y Google Cloud:

1. En Google Cloud habilita **Google Sheets API** y crea una Service Account.
2. Comparte la hoja con el correo de la Service Account como **Editor**. Comparte con cada persona de la empresa como **Lector**; el enlace por sí solo no da acceso a un documento restringido.
3. Configura en Supabase los secretos `GOOGLE_SHEETS_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` y `SYNC_CRON_SECRET`. La llave privada y el secreto de cron nunca van al frontend ni al repositorio.
4. Despliega la función `sync-google-sheets` después de publicar estos cambios. Habilita `pg_cron`, `pg_net` y Vault; configura `supabase/setup_cron.sql` con la URL desplegada y el mismo secreto de cron.
5. El cron revisa cada cinco minutos la cola `sync_log`. Las marcas se guardan primero en Supabase aunque Google falle. Los errores quedan registrados con estado, texto y número de intentos; al corregir la configuración, el botón de re-sincronización vuelve a poner el rango en cola.

La hoja debe tener pestañas nombradas con el mes en español (`NOVIEMBRE`, `DICIEMBRE`, etc.), las fechas como valores de fecha reales y los nombres de perfil que correspondan a los encabezados de fila 1. La función no crea filas ni modifica las fórmulas de horas.
## QR y reglas de marcas

- Al recargar el panel admin, la app vuelve a consultar y muestra la sesión activa hasta su vencimiento; recargar no invalida el QR ni la clave.
- El jefe genera desde el panel un QR y una clave numérica de 4 dígitos para la misma sesión. Cualquiera de los dos métodos sirve; renovarlos revoca ambos anteriores y vencen juntos a las 12 horas. La clave permite cinco intentos por trabajador cada 15 minutos.
- Cada trabajador inicia sesión individualmente y escanea el QR con la cámara del teléfono. Si la sesión está cerrada, el enlace pide iniciar sesión y luego procesa el QR.
- Al abrir un QR, la app retira `?qr=...` de la barra de direcciones y conserva el token solo en memoria mientras se confirma. El trabajador también puede escribir la clave. Ambos métodos muestran una confirmación de Ingreso o Salida; solo al aceptar se guarda la marca. Si se cancela, no se registra nada. Tras guardar aparece el aviso de éxito y la persona permanece en su panel.
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
