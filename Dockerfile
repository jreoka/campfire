# ---- Harbin: the malware scanner, built from source --------------------------
# Harbin (https://github.com/jreoka/harbin) decides with a machine-learned model
# compiled into the executable: one binary, one argument, no daemon, no
# signature database, no runtime and no network in the detection path. It still
# has no *runtime* dependencies — the container decompressors it uses (RAR, 7z,
# LZX, the filesystem readers) are Rust crates linked in at build time, so the
# shipped binary stays self-contained — but it is no longer a trivial compile:
# expect a few minutes here on the first build of a new pin, and seconds once the
# layer is cached. The toolchain still lives only in this throwaway stage.
#
# HARBIN_REF pins the exact commit, so a deploy is reproducible and picking up a
# new model is a one-line change. The clone + build is a cached layer, so it is
# paid once rather than on every deploy.
FROM rust:1-alpine AS harbin
RUN apk add --no-cache build-base git
ARG HARBIN_REPO=https://github.com/jreoka/harbin
ARG HARBIN_REF=9499ac08e9c267ce0a3c51984dc6f571be61cdb2
WORKDIR /src
# A full clone rather than a shallow one: the repository is well under a
# megabyte, and a pinned commit that is no longer the branch head still has to
# check out.
#
# The SHIPPED binary, deliberately: Harbin keeps every internal option
# (`--model-info`, `--dump-features`, ...) behind its `devtools` feature so the
# released scanner exposes exactly the one positional argument it documents —
# so this must not build with `--features devtools`.
RUN git clone --quiet "$HARBIN_REPO" . \
 && git checkout --quiet "$HARBIN_REF" \
 && cargo build --release --locked
# Prove the engine here, where a failure costs a build, rather than in
# production, where it would mean uploads silently failing open. A build with no
# embedded model answers CLEAN to everything, which is worse than no scanner, so
# refuse it — and print the loaded model's shape into the build log while we are
# at it. `HARBIN_VERBOSE=1` is the shipped build's own way to report that shape
# (the flag was devtools-only and is now compiled out); it goes to stderr during
# a real scan, which is the same line virus-scan.js's probe reads at runtime.
RUN set -e; \
    printf 'campfire build probe: harmless text\n' > /tmp/probe.bin; \
    HARBIN_VERBOSE=1 HARBIN_QUIET=1 target/release/harbin /tmp/probe.bin > /tmp/probe.log 2>&1 || true; \
    cat /tmp/probe.log; \
    if grep -q 'without a detection model' /tmp/probe.log; then \
      echo "harbin built without a detection model" >&2; exit 1; \
    fi; \
    if ! grep -q 'trees' /tmp/probe.log; then \
      echo "harbin reported no loaded model - the engine did not run" >&2; exit 1; \
    fi

FROM node:22-alpine

# pg_dump for the automatic S3 database backups, ffmpeg for the background
# media compressor. Malware scanning needs no packages at all: the engine is the
# self-contained binary copied in below (see the harbin stage), so there is no
# scanner daemon and no signature volume to keep in the image or in RAM.
# Uploads are staged in the temp dir while the engine reads them.
RUN apk add --no-cache postgresql-client ffmpeg

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY . .
RUN node scripts/gen-icons.js

COPY --from=harbin /src/target/release/harbin /usr/local/bin/harbin

ENV NODE_ENV=production \
    PORT=3000

VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "server.js"]
