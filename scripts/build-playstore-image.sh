#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-13}"
case "$TARGET" in
  12|13|14|15|16)
    VERSIONS=("$TARGET")
    ;;
  all)
    VERSIONS=(12 13 14 15 16)
    ;;
  *)
    echo "Usage: bash scripts/build-playstore-image.sh [12|13|14|15|16|all]" >&2
    exit 1
    ;;
esac

IMAGE_REPO="${REDROID_PLAYSTORE_IMAGE_REPO:-droidforge/redroid}"

for ANDROID_VERSION in "${VERSIONS[@]}"; do
  IMAGE_TAG="${IMAGE_REPO}:${ANDROID_VERSION}.0.0-playstore"

  echo "============================================================"
  echo " Building Redroid Android ${ANDROID_VERSION} + Play Store (MindTheGapps) + Built-in Google Chrome"
  echo " Target Image: ${IMAGE_TAG}"
  echo "============================================================"

  docker build \
    --pull \
    -f docker/redroid-playstore.Dockerfile \
    --build-arg "ANDROID_VERSION=${ANDROID_VERSION}" \
    -t "${IMAGE_TAG}" \
    .

  echo ""
  echo "[OK] Built Play Store + Chrome image: ${IMAGE_TAG}"
  docker images "${IMAGE_TAG}" --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}"
done
