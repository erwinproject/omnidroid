# DroidForge — Full Docker + Redroid Android Emulator Platform

Platform Android Emulator **100% Full Docker + Redroid** untuk **Server / VM Linux**, dilengkapi **REST + WebSocket API lengkap**, **Custom Device Profile & Anti-Emulator Stealth Engine**, **AI Agent Set-of-Marks Automation**, dan **Web Dashboard dengan Live Screen Streaming**.

## Port Allocation (Semua Port Unik > 10000)
| Service | Default Port | Deskripsi |
| :--- | :--- | :--- |
| **Web Dashboard (Nginx)** | `18080` | UI Web + reverse proxy `/api`, `/docs`, `/ws` |
| **API Server (Fastify)** | `13000` | Internal container & dev server |
| **Vite Dev Server** | `15173` | Mode development frontend |
| **Redroid Host ADB Ports** | `15555–19999` | Alokasi unik otomatis saat `exposeAdbPort: true` |

## Deployment di Server / VM Linux (Full Docker)
```bash
# 1. Aktifkan modul kernel binder_linux & verifikasi Docker
sudo bash scripts/setup-linux-host.sh

# 2. Konfigurasi environment & API Key
cp .env.example .env

# 3. Jalankan seluruh stack
docker compose up -d --build
```

- **Web Dashboard**: `http://<server-ip>:18080`
- **Swagger / OpenAPI Docs**: `http://<server-ip>:18080/docs`
- **OpenAPI JSON**: `http://<server-ip>:18080/openapi.json`

## Development & Automated Tests
```bash
npm install
npm run typecheck
npm run test
npm run build
npm run dev
```
