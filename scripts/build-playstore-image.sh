#!/usr/bin/env bash
set -euo pipefail

ANDROID_VERSION="${1:-13}"
case "$ANDROID_VERSION" in
  12|13|14) ;;
  *)
    echo "Usage: bash scripts/build-playstore-image.sh [12|13|14]" >&2
    exit 1
    ;;
esac

IMAGE_REPO="${REDROID_PLAYSTORE_IMAGE_REPO:-droidforge/redroid}"
IMAGE_TAG="${IMAGE_REPO}:${ANDROID_VERSION}.0.0-playstore"

echo "============================================================"
echo " Building Redroid Android ${ANDROID_VERSION} + Google Play Store"
echo " Target Image: ${IMAGE_TAG}"
echo "============================================================"

docker build \
  --pull \
  -f docker/redroid-playstore.Dockerfile \
  --build-arg "ANDROID_VERSION=${ANDROID_VERSION}" \
  -t "${IMAGE_TAG}" \
  .

echo ""
echo "[OK] Built Play Store image: ${IMAGE_TAG}"
docker images "${IMAGE_TAG}" --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}"
