ARG ANDROID_VERSION=13

FROM alpine:3.20 AS chrome
ARG TARGETARCH=amd64
ARG CHROME_APK_URL_AMD64="https://github.com/JonaNorman/WebViewPackage/releases/download/chrome/136.0.7103.125_min26_x86.apk"
ARG CHROME_APK_URL_ARM64="https://github.com/JonaNorman/WebViewPackage/releases/download/chrome/136.0.7103.125_min26_arm32+64.apk"

RUN apk add --no-cache curl unzip

RUN set -eu; \
  case "${TARGETARCH}" in \
    amd64) \
      CHROME_URL="${CHROME_APK_URL_AMD64}"; \
      CHROME_APK="/out/system/product/etc/preinstall/Chrome.apk"; \
      mkdir -p /out/system/product/etc/preinstall /out/system/product/bin /out/system/product/etc/init; \
      ;; \
    arm64) \
      CHROME_URL="${CHROME_APK_URL_ARM64}"; \
      CHROME_APK="/out/system/product/app/Chrome/Chrome.apk"; \
      mkdir -p /out/system/product/app/Chrome; \
      ;; \
    *) echo "Unsupported Chrome target arch: ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  echo "Downloading Google Chrome (${TARGETARCH}) from ${CHROME_URL} ..."; \
  curl -fSL --retry 3 -o "${CHROME_APK}" "${CHROME_URL}"; \
  unzip -tq "${CHROME_APK}" >/dev/null; \
  unzip -l "${CHROME_APK}" | grep -q 'AndroidManifest.xml'; \
  unzip -l "${CHROME_APK}" | grep -q 'libmonochrome.so'; \
  if [ "${TARGETARCH}" = "amd64" ]; then \
    printf '%s\n' \
      '#!/system/bin/sh' \
      "if ! pm path com.android.chrome 2>/dev/null | grep -q 'package:'; then" \
      '  pm install -r -g --abi x86 /system/product/etc/preinstall/Chrome.apk >/dev/null 2>&1 || true' \
      'fi' \
      > /out/system/product/bin/install-preinstalled-chrome.sh; \
    printf '%s\n' \
      'service droidforge_chrome_preinstall /system/bin/sh /system/product/bin/install-preinstalled-chrome.sh' \
      '    class late_start' \
      '    user root' \
      '    group root' \
      '    oneshot' \
      '    disabled' \
      '' \
      'on property:sys.boot_completed=1' \
      '    start droidforge_chrome_preinstall' \
      > /out/system/product/etc/init/chrome-preinstall.rc; \
  fi; \
  chmod -R a+rX,go-w /out/system; \
  if [ "${TARGETARCH}" = "amd64" ]; then \
    chmod 0755 /out/system/product/bin/install-preinstalled-chrome.sh; \
    chmod 0644 /out/system/product/etc/init/chrome-preinstall.rc; \
  fi

FROM debian:bookworm-slim AS gapps
ARG ANDROID_VERSION=13
ARG TARGETARCH=amd64

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    unzip \
    ca-certificates \
    findutils \
  && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
  mkdir -p /out/system; \
  if [ "${ANDROID_VERSION}:${TARGETARCH}" = "15:amd64" ] || [ "${ANDROID_VERSION}:${TARGETARCH}" = "16:amd64" ]; then \
    case "${ANDROID_VERSION}" in \
      15) VG_COMMIT="e14b22768c60978d0e1267dab5bcf62dfcc73d16" ;; \
      16) VG_COMMIT="f8cdcffc2fb9181b8cc5a9b02d4b5908b64e5cdd" ;; \
      *) echo "Unsupported vendor_gapps version ${ANDROID_VERSION}" >&2; exit 1 ;; \
    esac; \
    apt-get update && apt-get install -y --no-install-recommends git zip openjdk-17-jre-headless && rm -rf /var/lib/apt/lists/*; \
    git config --global http.version HTTP/1.1; \
    git init /tmp/vg; \
    ( \
      cd /tmp/vg && \
      git remote add origin https://gitlab.com/MindTheGapps/vendor_gapps.git && \
      git sparse-checkout init --cone && \
      git sparse-checkout set x86_64/proprietary common/proprietary overlay build/apktool build/sign && \
      git fetch --depth=1 --filter=blob:none origin "${VG_COMMIT}" && \
      git checkout FETCH_HEAD && \
      GAPPS_TOP=/tmp/vg GLOG=/tmp/gapps_overlays.log bash /tmp/vg/overlay/build_overlays.sh x86_64 /out && \
      cp -a /tmp/vg/x86_64/proprietary/. /out/system/ && \
      cp -a /tmp/vg/common/proprietary/. /out/system/ \
    ); \
    rm -rf /tmp/vg /tmp/gapps_overlays.log; \
    apt-get purge -y --auto-remove git zip openjdk-17-jre-headless && rm -rf /var/lib/apt/lists/*; \
    IKA_COMMIT="7e82e69053230bdb3b7d72a8ef47682abd51da67"; \
    IKA_RAW_BASE="https://raw.githubusercontent.com/DesktopECHO/ika/${IKA_COMMIT}/src/lineageos/prebuilts/mindthegapps/x86_64/gmscore"; \
    IKA_MEDIA_BASE="https://media.githubusercontent.com/media/DesktopECHO/ika/${IKA_COMMIT}/src/lineageos/prebuilts/mindthegapps/x86_64/gmscore"; \
    rm -rf /out/system/product/priv-app/GmsCore && mkdir -p /out/system/product/priv-app/GmsCore; \
    curl -fSL --retry 3 "${IKA_RAW_BASE}/SHA256SUMS" | tr -d '\r' > /tmp/gmscore.sha256; \
    for apk in $(awk '{print $2}' /tmp/gmscore.sha256); do \
      echo "Downloading modern x86_64 GmsCore component: ${apk} ..."; \
      curl -fSL --retry 3 -o "/out/system/product/priv-app/GmsCore/${apk}" "${IKA_MEDIA_BASE}/${apk}"; \
    done; \
    (cd /out/system/product/priv-app/GmsCore && sha256sum -c --strict /tmp/gmscore.sha256); \
    rm -f /tmp/gmscore.sha256; \
    PERM_XML="/out/system/product/etc/permissions/privapp-permissions-google-product.xml"; \
    GMS_BLOCK=$(awk '/<privapp-permissions package="com\.google\.android\.gms">/,/<\/privapp-permissions>/' "${PERM_XML}"); \
    MISSING_PERMS=""; \
    for perm in \
      android.permission.ACCESS_COMPANION_INFO \
      android.permission.GET_ROLE_HOLDERS \
      android.permission.LOG_COMPAT_CHANGE \
      android.permission.MANAGE_SECURE_LOCK_DEVICE \
      android.permission.OBSERVE_ROLE_HOLDERS \
      android.permission.PACKET_KEEPALIVE_OFFLOAD \
      android.permission.READ_COMPAT_CHANGE_CONFIG; do \
      if ! printf '%s\n' "${GMS_BLOCK}" | grep -q "name=\"${perm}\""; then \
        MISSING_PERMS="${MISSING_PERMS}        <permission name=\"${perm}\"/>\n"; \
      fi; \
    done; \
    if [ -n "${MISSING_PERMS}" ]; then \
      awk -v ins="${MISSING_PERMS}" '{print; if ($0 ~ /<privapp-permissions package="com\.google\.android\.gms">/) printf "%s", ins}' "${PERM_XML}" > "${PERM_XML}.tmp"; \
      mv "${PERM_XML}.tmp" "${PERM_XML}"; \
    fi; \
    awk '/<privapp-permissions package="com\.google\.android\.gms">/,/<\/privapp-permissions>/' "${PERM_XML}" | grep -q 'android.permission.OBSERVE_ROLE_HOLDERS'; \
    test "$(stat -c%s /out/system/product/priv-app/GmsCore/GmsCore.apk)" -gt 100000000; \
    test -f /out/system/product/priv-app/GmsCore/split_GoogleCertificates_installtime.apk; \
    test "$(stat -c%s /out/system/product/priv-app/Phonesky/Phonesky.apk)" -gt 50000000; \
    test -n "$(find /out/system/product/overlay -maxdepth 1 -name '*.apk' | head -n 1)"; \
  else \
    MD5=""; \
    SHA256=""; \
    case "${ANDROID_VERSION}:${TARGETARCH}" in \
      12:amd64) \
        URL="https://github.com/s1204IT/MindTheGappsBuilder/releases/download/20240619/MindTheGapps-12.1.0-x86_64-20240619.zip"; \
        MD5="05d6e99b6e6567e66d43774559b15fbd" ;; \
      12:arm64) \
        URL="https://github.com/s1204IT/MindTheGappsBuilder/releases/download/20240619/MindTheGapps-12.1.0-arm64-20240619.zip"; \
        MD5="94dd174ff16c2f0006b66b25025efd04" ;; \
      13:amd64) \
        URL="https://github.com/s1204IT/MindTheGappsBuilder/releases/download/20240226/MindTheGapps-13.0.0-x86_64-20240226.zip"; \
        MD5="eee87a540b6e778f3a114fff29e133aa" ;; \
      13:arm64) \
        URL="https://github.com/s1204IT/MindTheGappsBuilder/releases/download/20240226/MindTheGapps-13.0.0-arm64-20240226.zip"; \
        MD5="ebdf35e17bc1c22337762fcf15cd6e97" ;; \
      14:amd64) \
        URL="https://github.com/s1204IT/MindTheGappsBuilder/releases/download/20240226/MindTheGapps-14.0.0-x86_64-20240226.zip"; \
        MD5="a827a84ccb0cf5914756e8561257ed13" ;; \
      14:arm64) \
        URL="https://github.com/s1204IT/MindTheGappsBuilder/releases/download/20240226/MindTheGapps-14.0.0-arm64-20240226.zip"; \
        MD5="a0905cc7bf3f4f4f2e3f59a4e1fc789b" ;; \
      15:arm64) \
        URL="https://github.com/s1204IT/MindTheGappsBuilder/releases/download/20250330/MindTheGapps-15.0.0-arm64-20250330.zip"; \
        SHA256="afe8e6f3a0439f2310b04126dcbfb5f60b7c28ac47d4e06cb57a7ef9463580c6" ;; \
      16:arm64) \
        URL="https://github.com/MindTheGapps/16.0.0-arm64/releases/download/MindTheGapps-16.0.0-arm64-20261023_034858/MindTheGapps-16.0.0-arm64-20261023_034858.zip"; \
        SHA256="6929593937cd85541228e4e5db9cbb5455338bf33c75eabf610de632ac155810" ;; \
      *) \
        echo "Unsupported MindTheGapps target ${ANDROID_VERSION}:${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    echo "Downloading ${URL} ..."; \
    curl -fSL --retry 3 -o /tmp/mindthegapps.zip "${URL}"; \
    if [ -n "${MD5}" ]; then \
      echo "${MD5}  /tmp/mindthegapps.zip" | md5sum -c -; \
    fi; \
    if [ -n "${SHA256}" ]; then \
      echo "${SHA256}  /tmp/mindthegapps.zip" | sha256sum -c -; \
    fi; \
    mkdir -p /tmp/extract; \
    unzip -q /tmp/mindthegapps.zip -d /tmp/extract; \
    if [ -d /tmp/extract/system ]; then \
      cp -a /tmp/extract/system/. /out/system/; \
    fi; \
    for sub in product system_ext vendor; do \
      if [ -d "/tmp/extract/${sub}" ]; then \
        mkdir -p "/out/system/${sub}"; \
        cp -a "/tmp/extract/${sub}/." "/out/system/${sub}/"; \
      fi; \
    done; \
    rm -rf /tmp/extract /tmp/mindthegapps.zip; \
  fi; \
  test -n "$(find /out/system -iname '*Phonesky*' | head -n 1)"; \
  test -n "$(find /out/system -iname '*PrebuiltGmsCore*' -o -iname '*GmsCore*' | head -n 1)"; \
  chmod -R a+rX,go-w /out/system

FROM redroid/redroid:${ANDROID_VERSION}.0.0-latest

COPY --from=gapps /out/system /system
COPY --from=chrome /out/system /system

ENTRYPOINT ["/init", "qemu=1", "androidboot.hardware=redroid", "ro.setupwizard.mode=DISABLED"]
