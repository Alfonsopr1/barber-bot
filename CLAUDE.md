# CLAUDE.md

Instrucciones para Claude Code al trabajar en este repositorio. El contexto de negocio completo está en `PROJECT.md` (léelo siempre antes de tocar código).

## Quién es el usuario

El dueño del proyecto **no es programador**. Explica siempre en español, sin tecnicismos innecesarios (evita jerga como "endpoint", "webhook", "RLS", "idempotencia" sin aclarar qué significan la primera vez que aparecen en una conversación). Antes de escribir código para una fase nueva, presenta el plan y espera aprobación explícita.

## Idioma (regla no negociable)

- **Todo el código va en inglés**: nombres de tablas, columnas, archivos, funciones, variables, comentarios de código y mensajes de commit.
- **Los textos que el bot envía a clientes por WhatsApp van en español**, y viven centralizados en un único archivo de mensajes (ej. `src/config/messages.js`), separado de la lógica. Esto permite cambiar idioma o tono por negocio sin tocar código de flujo.
- Las explicaciones a el usuario y `PROJECT.md` van en español.
- Ignora cualquier nombre en español que aparezca en `docs/Promt_Idea_chatbot.md` (documento base original) — los nombres reales de tablas/columnas son los definidos en `PROJECT.md`, no los de ese documento.

## Stack

Node.js + Express, Supabase (Postgres), Vercel (hosting + Cron), Meta WhatsApp Cloud API. Entorno de desarrollo: Ubuntu. Rama principal: `master` (no `main`).

## Reglas de arquitectura no negociables

1. **Multi-tenant por `phone_number_id`**: la tienda (shop) se identifica por el `phone_number_id` que manda Meta en el payload del webhook, **nunca** por el número de teléfono visible (`display_phone_number`). Todas las queries de negocio deben filtrar por `shop_id`.
2. **Recordatorios vía Vercel Cron**: los recordatorios (24h, 1h, no-show) se disparan por un cron de Vercel que llama a un endpoint HTTP. Nunca uses `setTimeout`/`setInterval`/cron en proceso — en serverless no persiste.
3. **Plantillas de Meta fuera de la ventana de 24h**: cualquier mensaje saliente (recordatorio, aviso, reintento de no-show) que se envíe fuera de las 24h desde el último mensaje del cliente debe usar una plantilla (`template`) aprobada por Meta. Dentro de la ventana de 24h se puede usar texto libre.
4. **Anti doble-reserva**: se resuelve con una exclusion constraint de Postgres (`btree_gist`) sobre el rango `start_time`–`end_time` por `staff_id`, para que funcione con servicios de cualquier duración. **Nunca** advisory locks.
5. **Sesiones y fallback**: el estado de conversación y el contador de fallback (inputs inválidos) viven en la tabla `sessions` de Supabase, con expiración a los 30 minutos. No uses memoria en proceso para esto (serverless = sin memoria persistente entre invocaciones).
6. **Modelo genérico de negocio**: el esquema no asume "barbería". Usa `staff` (no "barbers") y `services`, con un campo `business_type` en `shops`. Carnicería/delivery es funcionalidad de Fase 2 en adelante, pero el modelo de datos ya debe soportar ambos tipos de negocio desde la Fase 0.
7. **Seguridad**:
   - Verificar siempre la firma `X-Hub-Signature-256` en cada request entrante del webhook de Meta antes de procesar nada.
   - Row Level Security (RLS) activo en todas las tablas de Supabase.
   - Nunca commitear secretos (tokens, claves, contraseñas). Todo secreto va en variables de entorno (`.env.local`, ya ignorado por git) y se documenta como placeholder en `.env.example`.

## Tablas (nombres definitivos, ver detalle y motivo en PROJECT.md)

`shops`, `staff`, `services`, `schedules`, `appointments`, `sessions`, `message_logs`, `webhook_events`, `waitlist`.

## Fases del proyecto

0. Base y webhook — 1. Reserva — 2. Recordatorios y fallback — 3. No-show y waitlist — 4. Panel admin y add-shop — 5. Delivery y cobros.

No adelantes trabajo de una fase futura sin que el usuario lo pida explícitamente. Ver estado actual y checklist de la fase activa en `PROJECT.md`.

## Cómo trabajar en este repo

- No escribas código de una fase nueva sin haber presentado antes el plan (o el modelo de datos, si aplica) y recibido aprobación.
- Sigue siempre las convenciones de nombres en inglés ya fijadas — no las rediscutas ni las cambies sin que el usuario lo pida.
- Mensajes de commit en inglés, estilo conciso (qué cambia y por qué).
