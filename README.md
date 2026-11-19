# DroidForge — Full Docker + Redroid Android Emulator Platform

Platform Android Emulator **100% Full Docker + Redroid** untuk **Server / VM Linux**, dilengkapi **REST + WebSocket API lengkap**, **Custom Device Profile & Anti-Emulator Stealth Engine**, **Multi-Protocol Proxy Relay (HTTP / HTTPS / SOCKS5 + Auth + Pool + Verifikasi Exit IP)**, **Google Play Store (MindTheGapps) Image Builder**, **AI Agent Set-of-Marks Automation**, dan **Web Dashboard Neo-Brutalist Responsif dengan Live Screen Streaming**.

## Port Allocation (Semua Port Unik > 10000)
| Service | Default Port | Deskripsi |
| :--- | :--- | :--- |
| **Web Dashboard (Nginx)** | `18080` | UI Web + reverse proxy `/api`, `/docs`, `/ws` |
| **API Server (Fastify)** | `13000` | Internal container & dev server |
| **Vite Dev Server** | `15173` | Mode development frontend |
| **Redroid Host ADB Ports** | `15555–19999` | Alokasi unik otomatis saat `exposeAdbPort: true` |
| **Proxy Relay Ports** | `24000–24999` | Relay lokal per-instance untuk HTTP/HTTPS/SOCKS5 proxy berautentikasi |

## Deployment di Server / VM Linux (Full Docker)
```bash
# 1. Aktifkan modul kernel binder_linux & verifikasi Docker
sudo bash scripts/setup-linux-host.sh

# 2. Konfigurasi environment & API Key
cp .env.example .env

# 3. (Opsional) Build image Redroid + Google Play Store (Android 12 / 13 / 14)
bash scripts/build-playstore-image.sh 13

# 4. Jalankan seluruh stack
docker compose up -d --build
```

- **Web Dashboard**: `http://<server-ip>:18080`
- **Swagger / OpenAPI Docs**: `http://<server-ip>:18080/docs`
- **OpenAPI JSON**: `http://<server-ip>:18080/openapi.json`

## Fitur Proxy Lengkap
- Mendukung protokol `http`, `https`, dan `socks5` (`socks5h://` otomatis resolusi DNS di sisi proxy tanpa DNS leak).
- Mendukung autentikasi `username:password` untuk HTTP/HTTPS CONNECT dan SOCKS5 RFC 1929 lewat relay per-instance di `emulator-net`.
- Proxy Pool tersimpan di SQLite + Bulk Import + Tester latensi/exit IP/negara/ISP + Verifikasi langsung dari dalam container Android + sinkronisasi timezone.

## Development & Automated Tests
```bash
npm install
npm run typecheck
npm run test
npm run build
npm run dev
```
