Construye un bot de WhatsApp multi-tenant para barberías.
Stack: Node.js, Express, Supabase (Postgres), Meta WhatsApp Cloud API, Vercel.

Estructura de carpetas:

barber-bot/
├── src/
│ ├── bot/
│ │ ├── index.js ← webhook de Meta (entry point)
│ │ ├── router.js ← parsea mensajes, decide intención
│ │ ├── booking.js ← agendar, cambiar, cancelar
│ │ ├── notifications.js ← recordatorios 24h/1h, avisos a barberos
│ │ ├── fallback.js ← inputs inválidos (3 niveles + handoff)
│ │ └── noShow.js ← reintentos, liberar slot, lista de espera
│ ├── api/
│ │ ├── admin.js ← panel /admin (ver todas las barberías)
│ │ └── health.js
│ ├── db/
│ │ ├── schema.sql ← CREATE TABLE completo
│ │ └── add-shop.js ← CLI: node add-shop.js "Nombre" "+1555" "Ciudad"
│ ├── config/
│ │ ├── env.example
│ │ └── constants.js
│ └── utils/
│ ├── whatsapp.js ← wrapper Meta Cloud API
│ └── scheduler.js ← cron (recordatorios)
├── vercel.json
├── package.json
└── .gitignore

Base de datos:

• shops: id, nombre, whatsapp_number, ciudad, moneda, activa
• barbers: id, shop_id, nombre, whatsapp_personal
• schedules: id, barber_id, fecha, hora_inicio, hora_fin, disponible
• appointments: id, shop_id, barber_id, client_name, client_phone, fecha, hora, servicio, precio, estado
• waitlist: id, shop_id, client_phone, fecha_deseada, hora_deseada, activa

Reglas:

1. Multi-tenant: el webhook identifica shop_id por el número WhatsApp receptor.
TODAS las queries filtran por shop_id.
2. Flujo: cliente escribe → bot muestra slots libres de los 3 barberos →
cliente elige → bot confirma → NOTIFICA al barbero por WhatsApp personal.
3. Recordatorios: 24h antes (cliente + barbero), 1h antes (barbero).
4. No-show: si no responde en 24h → reintento 2h antes → a la hora: no_show.
Liberar slot, avisar barbero, ofrecer a waitlist, mensaje suave al día siguiente.
5. Fallback: 3 niveles (menú → botones quick reply → handoff humano).
Reset contador si input válido. Timeout sesión: 30 min.
6. Race condition: advisory lock en Postgres. Primero en confirmar gana.
7. Admin /admin (protegido con contraseña): tabla de shops con citas hoy,
no-shows, estado. Click → editar horarios, pausar bot, ver logs.
8. add-shop.js: agrega una barbería nueva por CLI sin tocar código.

Genera TODO el código completo y funcional.
Incluye schema.sql, package.json, vercel.json, .gitignore y README.md
con instrucciones de setup paso a paso.