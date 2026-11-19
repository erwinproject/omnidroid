ARG ANDROID_VERSION=13

FROM alpine:3.20 AS gapps
ARG ANDROID_VERSION=13
ARG TARGETARCH=amd64

RUN apk add --no-cache curl unzip findutils

RUN set -eu; \
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
    *) \
      echo "Unsupported MindTheGapps target ${ANDROID_VERSION}:${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  echo "Downloading ${URL} ..."; \
  curl -fSL --retry 3 -o /tmp/mindthegapps.zip "${URL}"; \
  echo "${MD5}  /tmp/mindthegapps.zip" | md5sum -c -; \
  mkdir -p /tmp/extract /out/system; \
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
  test -n "$(find /out/system -iname '*Phonesky*' | head -n 1)"; \
  test -n "$(find /out/system -iname '*PrebuiltGmsCore*' -o -iname '*GmsCore*' | head -n 1)"; \
  chmod -R a+rX,go-w /out/system

FROM redroid/redroid:${ANDROID_VERSION}.0.0-latest

COPY --from=gapps /out/system /system

ENTRYPOINT ["/init", "qemu=1", "androidboot.hardware=redroid", "ro.setupwizard.mode=DISABLED"]
