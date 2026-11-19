#!/usr/bin/env bash
set -euo pipefail

echo "============================================================"
echo " DroidForge - Linux Host Setup for Full Docker + Redroid"
echo "============================================================"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "[ERROR] This script must be run on a Linux server or VM."
  exit 1
fi

if [[ "$EUID" -ne 0 ]]; then
  echo "[ERROR] Please run as root: sudo bash scripts/setup-linux-host.sh"
  exit 1
fi

echo "[1/4] Checking kernel modules (binder_linux)..."
if ! modprobe binder_linux devices="binder,hwbinder,vndbinder" 2>/dev/null; then
  echo "  -> binder_linux not loaded yet. Installing linux-modules-extra-$(uname -r)..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y "linux-modules-extra-$(uname -r)" || true
    modprobe binder_linux devices="binder,hwbinder,vndbinder"
  else
    echo "[ERROR] Please install kernel modules providing binder_linux for your distro."
    exit 1
  fi
fi

# Persist module across reboots
cat <<EOF > /etc/modules-load.d/redroid.conf
binder_linux
EOF

cat <<EOF > /etc/modprobe.d/redroid.conf
options binder_linux devices="binder,hwbinder,vndbinder"
EOF

echo "[2/4] Verifying binderfs support..."
if grep -q binder /proc/filesystems; then
  echo "  -> binderfs is ACTIVE."
else
  echo "[ERROR] binderfs not found in /proc/filesystems after modprobe."
  exit 1
fi

echo "[3/4] Checking Docker & Docker Compose..."
if ! command -v docker >/dev/null 2>&1; then
  echo "[ERROR] Docker is not installed. Install Docker Engine first: https://docs.docker.com/engine/install/"
  exit 1
fi
docker --version
docker compose version

echo "[4/4] Optional: Pre-pulling Redroid Android 13 image..."
if [[ "${PULL_IMAGE:-false}" == "true" ]]; then
  docker pull redroid/redroid:13.0.0-latest
else
  echo "  -> Skipped (set PULL_IMAGE=true to pre-pull redroid/redroid:13.0.0-latest)."
fi

echo ""
echo "[OK] Linux host is ready for DroidForge Full Docker + Redroid!"
echo "Next steps:"
echo "  1. cp .env.example .env && nano .env"
echo "  2. docker compose up -d --build"
echo "  3. Open Dashboard: http://<server-ip>:18080"
echo "  4. Open Swagger:   http://<server-ip>:18080/docs"
