# Timeline Watcher - Arquitectura

## Diagrama

```
┌─────────────────────────────────────────────────────────────────────┐
│                           RAILWAY                                   │
│                                                                     │
│   ┌─────────────────┐         ┌─────────────────┐                  │
│   │   Timeline API  │ ──────▶ │   PostgreSQL    │                  │
│   │   (Node.js)     │         │   (base datos)  │                  │
│   └────────┬────────┘         └─────────────────┘                  │
│            │                         │                              │
│            │                         │ Guarda:                      │
│            │                         │ • Tus API keys               │
│            │                         │ • Tokens OAuth               │
│            │                         │ • Config (frecuencia, etc)   │
│            │                         │ • Tweets ya vistos           │
│            │                                                        │
│            │  Cada 6 horas:                                         │
│            │  1. Lee tu timeline de X                               │
│            │  2. Filtra tweets nuevos                               │
│            │  3. Manda a tu webhook ─────────────────────┐          │
│            │                                             │          │
└────────────┼─────────────────────────────────────────────┼──────────┘
             │                                             │
             │                                             ▼
┌────────────┴────────────┐                 ┌─────────────────────────┐
│      X (Twitter)        │                 │       TU EC2            │
│                         │                 │                         │
│  • Tu feed/timeline     │                 │   Webhook Server (:3001)│
│  • OAuth API            │                 │         │               │
│                         │                 │         ▼               │
└─────────────────────────┘                 │   OpenClaw              │
                                            │         │               │
                                            │         ▼               │
                                            │   Te avisa por          │
                                            │   WhatsApp/Telegram     │
                                            └─────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                           VERCEL                                    │
│                                                                     │
│   ┌─────────────────┐                                              │
│   │    Dashboard    │  ◀───── Vos entrás acá para:                 │
│   │    (Next.js)    │         • Ver estado                         │
│   └────────┬────────┘         • Cambiar config                     │
│            │                  • Hacer poll manual                   │
│            │                                                        │
│            └──────────────────▶ Habla con la API de Railway        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Flujo

1. **Cada 6 horas** → Railway llama a X API y baja tu timeline
2. **Filtra** → Solo tweets nuevos que no viste
3. **Manda a EC2** → Webhook recibe el batch
4. **OpenClaw procesa** → Decide qué es interesante
5. **Te avisa** → Por WhatsApp/Telegram

## URLs

| Componente | Plataforma | URL |
|------------|------------|-----|
| API | Railway | https://mcp-server-production-09d7.up.railway.app |
| Dashboard | Vercel | https://dashboard-di2tzibil-pichme.vercel.app |
| Webhook | EC2 | http://3.128.188.184:3001/webhook |
| Base de datos | Railway | PostgreSQL (interno) |

## Componentes

### API (Railway)
- **Ubicación:** `/api`
- **Función:** Pollea X, guarda estado, manda webhooks
- **Endpoints:**
  - `GET /health` - Health check
  - `GET /api/config` - Ver configuración
  - `PUT /api/config` - Actualizar configuración
  - `GET /api/status` - Estado actual
  - `POST /api/poll` - Poll manual
  - `GET /api/polls` - Historial de polls

### Dashboard (Vercel)
- **Ubicación:** `/dashboard`
- **Función:** UI para configurar y monitorear
- **Features:**
  - Configurar API keys de X
  - Setear frecuencia de polling
  - Ver historial de polls
  - Trigger poll manual

### Webhook Server (EC2)
- **Ubicación:** EC2 `~/elon-watcher/webhook-server`
- **Función:** Recibe tweets y los pasa a OpenClaw
- **Puerto:** 3001

## Configuración

### Variables en Railway
- `DATABASE_URL` - Conexión a PostgreSQL (auto-seteada)

### Variables en Vercel
- `NEXT_PUBLIC_API_URL` - URL de la API de Railway

### Datos en PostgreSQL
- `config` - API keys, tokens, webhook URL, frecuencia
- `seen_tweets` - IDs de tweets ya procesados
- `poll_log` - Historial de polls
