# PROJECT.md

Documento vivo del proyecto. Aquí vive el contexto de negocio, las decisiones ya tomadas y el estado de cada fase. Se actualiza a medida que avanzamos.

## Qué es esto

Un SaaS de chatbot de WhatsApp **multi-tenant**: un mismo sistema atiende a varios negocios distintos (varias "tiendas"), cada uno con su propio número de WhatsApp, su propio staff, sus propios servicios y sus propias citas — sin mezclar datos entre ellos.

- **Fase actual del negocio**: barberías (agendamiento de citas con un barbero).
- **Siguiente vertical de negocio** (no antes de la Fase 2 técnica): carnicerías con delivery — pedidos en vez de citas.
- El modelo de datos se diseña genérico desde el día uno (`business_type` en la tienda, `staff` y `services` en vez de nombres específicos de barbería) para no tener que migrar el esquema cuando se agregue la segunda vertical.

El documento original de la idea está en `docs/Promt_Idea_chatbot.md`. Ese documento sirvió como punto de partida, pero **varias decisiones cambiaron** respecto a él (detalladas abajo) y los nombres en español de ese documento no se usan — los nombres reales están en este archivo.

## Decisiones clave ya tomadas

| Tema | Decisión | Por qué |
|---|---|---|
| Identidad de la tienda | Se identifica por `phone_number_id` (el ID interno que manda Meta), no por el número visible | El número visible puede cambiar de formato/representación; `phone_number_id` es el identificador estable que Meta manda siempre en el payload |
| Recordatorios | Vercel Cron llama a un endpoint HTTP en un horario fijo | Vercel es serverless: un cron "en proceso" (`setInterval`) no sobrevive entre invocaciones |
| Mensajes fuera de 24h | Deben usar plantillas (`templates`) aprobadas por Meta | Meta bloquea texto libre fuera de la ventana de 24h desde el último mensaje del cliente |
| Anti doble-reserva | Exclusion constraint de Postgres (`btree_gist`) sobre el rango `start_time`–`end_time` por `staff_id` | Las duraciones de los servicios varían (30/45/60 min); un índice único simple solo evita horas de inicio idénticas, no turnos que se solapan con duraciones distintas |
| Sesión de conversación y fallback | Tabla `sessions` en Supabase, expira a los 30 min | Serverless no tiene memoria persistente entre invocaciones; necesita vivir en la base de datos |
| Modelo de negocio | Genérico: `staff` + `services` + `business_type`, no específico de barbería | Reutilizar el mismo esquema para la Fase 2 (carnicerías) sin migrar tablas |
| Idempotencia de webhooks | Tabla `webhook_events` | Meta puede reintentar el mismo evento; hay que procesar cada uno una sola vez |
| Seguridad | Verificar `X-Hub-Signature-256`, RLS activo, cero secretos commiteados | Evitar que cualquiera pueda mandar payloads falsos al webhook o filtrar credenciales |

## Supuesto pendiente de confirmar contigo

Para que **un mismo backend** atienda varias tiendas, cada una con su propio número de WhatsApp, hay dos formas de organizarlo del lado de Meta:

1. **Un solo "Business Manager" tuyo, varios números registrados bajo la misma app** (todas las tiendas usan el mismo token de acceso; el `phone_number_id` de cada número es lo que las distingue). Más simple de montar ahora.
2. **Cada tienda conecta su propia cuenta de WhatsApp Business** (flujo "Embedded Signup" de Meta), cada una con su propio token. Más flexible para vender el SaaS a terceros, pero es más trabajo de integración.

**Voy a asumir la opción 1 para las Fases 0–4** (vos administrás los números, similar a `add-shop.js` del documento original), y dejamos la opción 2 como posible trabajo de Fase 4+ si en algún momento querés que otros negocios se auto-registren sin que vos gestiones sus números. Avisame si esto no es lo que tenías en mente.

## Modelo de datos (propuesto — pendiente de tu aprobación)

Nombres de tabla y columna en inglés (regla fija, ver `CLAUDE.md`). Todas las tablas de negocio tienen `shop_id` y RLS activo.

### `shops`
Una fila por negocio/tienda (tenant).
- `id` (uuid, pk)
- `name`
- `business_type` (`'barbershop'` por ahora; `'butchery'` en Fase 2)
- `phone_number_id` (texto, **único**, not null) — identificador real de Meta, usado para enrutar cada mensaje entrante a la tienda correcta
- `display_phone_number` (texto) — número visible, solo informativo/UI, nunca para lógica
- `timezone`, `currency`
- `is_active` (booleano)
- `created_at`

### `staff`
Personas que atienden citas (barberos, y a futuro repartidores/otros roles).
- `id` (uuid, pk)
- `shop_id` (fk)
- `name`
- `personal_whatsapp` — número personal para notificarle citas nuevas
- `is_active`
- `created_at`

### `services`
Qué se puede agendar (corte, barba, etc.), con duración y precio.
- `id` (uuid, pk)
- `shop_id` (fk)
- `name`
- `duration_minutes`
- `price`
- `is_active`

### `schedules`
Bloques de disponibilidad de cada miembro del staff.
- `id` (uuid, pk)
- `shop_id` (fk)
- `staff_id` (fk)
- `date`
- `start_time`, `end_time`
- `is_available`

### `appointments`
Las citas agendadas.
- `id` (uuid, pk)
- `shop_id` (fk)
- `staff_id` (fk)
- `service_id` (fk)
- `client_name`, `client_phone`
- `date` (solo para consultas simples tipo "citas de hoy")
- `start_time`, `end_time` (fecha + hora completas, no solo la hora — necesario para comparar rangos de horario)
- `price` (copia del precio del servicio al momento de agendar, por si el precio cambia después)
- `status` (`pending` / `confirmed` / `cancelled` / `no_show` / `completed`)
- `reminder_24h_sent_at`, `reminder_1h_sent_at` (nulos hasta que se envían — evita mandar el mismo recordatorio dos veces)
- `created_at`, `updated_at`
- **Anti doble-reserva**: exclusion constraint de Postgres (extensión `btree_gist`) que bloquea, para el mismo `staff_id`, cualquier par de citas activas (`pending`/`confirmed`) cuyos rangos `start_time`–`end_time` se toquen. Funciona sin importar la duración de cada servicio (30, 45, 60 min, lo que sea) porque compara rangos de tiempo reales, no solo la hora de inicio.

### `waitlist` (se usa desde Fase 3)
- `id`, `shop_id` (fk), `client_phone`, `service_id` (fk), `desired_date`, `desired_time`, `is_active`, `created_at`

### `sessions`
Estado de la conversación de WhatsApp por cliente + contador de fallback.
- `id` (uuid, pk)
- `shop_id` (fk)
- `client_phone`
- `state` (jsonb) — en qué paso del flujo está y datos que lleva juntados
- `fallback_count` (entero, default 0) — se resetea cuando el cliente manda un input válido
- `expires_at` — se calcula como "ahora + 30 min" en cada interacción válida
- `updated_at`
- único por `(shop_id, client_phone)`

### `message_logs`
Auditoría de todo mensaje entrante/saliente, y también sirve para no reenviar recordatorios.
- `id` (uuid, pk)
- `shop_id` (fk)
- `appointment_id` (fk, nullable)
- `client_phone`
- `direction` (`inbound` / `outbound`)
- `message_type` (`text`, `template`, `interactive`, etc.)
- `template_name` (nullable)
- `content` (jsonb)
- `meta_message_id` (nullable) — id que devuelve Meta (`wamid`)
- `status` (`sent` / `delivered` / `read` / `failed`, se actualiza con los webhooks de status de Meta)
- `created_at`

### `webhook_events`
Idempotencia: Meta puede reenviar el mismo evento más de una vez.
- `id` (uuid, pk)
- `meta_event_id` (texto, único) — id del mensaje o del evento de status que manda Meta
- `event_type` (`message` / `status`)
- `payload` (jsonb) — el body crudo, para debug
- `processed_at`
- `created_at`

## Fases

- **Fase 0 — Base y webhook** ← estamos acá
- Fase 1 — Reserva (flujo completo de agendar/cambiar/cancelar cita)
- Fase 2 — Recordatorios (24h/1h vía Vercel Cron + plantillas Meta) y fallback (3 niveles + handoff)
- Fase 3 — No-show (reintentos, liberar slot) y waitlist
- Fase 4 — Panel admin (ver todas las tiendas) y `add-shop` (alta de tienda nueva sin tocar código)
- Fase 5 — Delivery y cobros (carnicerías)

### Fase 0 — Base y webhook — ✅ cerrada (funciona de punta a punta en producción)

**Objetivo**: tener el esqueleto del proyecto funcionando en Vercel, recibiendo mensajes reales de WhatsApp, identificando correctamente a qué tienda pertenece cada mensaje, y guardando todo en la base de datos — sin lógica de negocio todavía (eso es Fase 1).

**Qué incluye**:
1. Estructura de carpetas base (`src/bot`, `src/api`, `src/db`, `src/config`, `src/utils`).
2. `schema.sql` con las 9 tablas de arriba, RLS activo en todas, y los índices/constraints de idempotencia y anti doble-reserva.
3. Cliente de Supabase configurado (usa la clave de servicio solo del lado del servidor, nunca expuesta al cliente).
4. Endpoint del webhook de Meta:
   - `GET` — responde el desafío de verificación que pide Meta al configurar el webhook.
   - `POST` — verifica la firma `X-Hub-Signature-256`, revisa `webhook_events` para no procesar el mismo evento dos veces, identifica la tienda por `phone_number_id`, guarda el mensaje entrante en `message_logs`.
5. `src/utils/whatsapp.js`: funciones básicas para enviar mensajes de texto y plantillas a la API de Meta.
6. `src/config/messages.js`: archivo centralizado de textos en español (vacío o con un mensaje de bienvenida genérico por ahora).
7. `.env.example` con los nombres de las variables necesarias (sin valores reales).
8. `vercel.json` mínimo para desplegar el endpoint.

**Entregable / cómo sabemos que la Fase 0 está lista**:
- Meta puede verificar el webhook exitosamente.
- Al mandar un mensaje de WhatsApp a un número de prueba, el sistema identifica la tienda correcta por `phone_number_id`, guarda el evento en `webhook_events` (sin duplicar en reintentos) y el mensaje en `message_logs`.
- El bot responde algo genérico (ej. "Hola, en construcción") — todavía no hay flujo de reserva.
- Ningún secreto quedó commiteado; `.env.local` sigue ignorado por git.

**Fuera de alcance de la Fase 0** (viene después): flujo de reserva, recordatorios, fallback con reintentos, no-show, panel admin.

**Pulido posterior al cierre**: el webhook respondía 200 antes de terminar el trabajo (Vercel podía "congelar" la función antes de que el guardado terminara); la app nunca había quedado efectivamente suscrita al WABA (`subscribed_apps` solo tenía la app interna de prueba de Meta); el mensaje saliente del bot no se registraba en `message_logs`. Los tres quedaron corregidos, con pruebas automáticas.

**Pendiente conocido para la Fase 3 (no-show)**: los avisos de estado de WhatsApp (`sent` → `delivered` → `read`) comparten el mismo `wamid` para un mismo mensaje. Como `webhook_events.meta_event_id` es único, solo el primer aviso de cada mensaje se guarda — los siguientes se descartan correctamente por el dedupe de idempotencia (no es un bug, pero sí una pérdida de información: hoy no se puede saber si un mensaje llegó a entregarse o a leerse, solo que se intentó enviar). La Fase 3 va a necesitar una clave de idempotencia distinta para los eventos de `status` (por ejemplo, combinar el `wamid` con el valor del estado) si se quiere trackear la progresión completa sent → delivered → read.

## Notas

- Repo: `barber-bot`, rama principal `master`.
- El nombre del repo quedó como `barber-bot` aunque el sistema es genérico — no hace falta renombrarlo.
