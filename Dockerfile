# ---- Harbin: the malware scanner, built from source --------------------------
# Harbin (https://github.com/jreoka/harbin) decides with a machine-learned model
# compiled into the executable: one binary, one argument, no daemon, no
# signature database, no runtime and no network in the detection path. It is a
# zero-dependency Rust crate, so it builds in seconds and the toolchain can stay
# in this throwaway stage instead of the runtime image.
#
# HARBIN_REF pins the exact commit, so a deploy is reproducible and picking up a
# new model is a one-line change. The clone + build is a cached layer, so it is
# paid once rather than on every deploy.
FROM rust:1-alpine AS harbin
RUN apk add --no-cache build-base git
ARG HARBIN_REPO=https://github.com/jreoka/harbin
ARG HARBIN_REF=865422217159ff47bf876db48426d62ee67ee401
WORKDIR /src
# A full clone rather than a shallow one: the repository is well under a
# megabyte, and a pinned commit that is no longer the branch head still has to
# check out.
RUN git clone --quiet "$HARBIN_REPO" . \
 && git checkout --quiet "$HARBIN_REF" \
 && cargo build --release --locked
# Prove it here, where a failure costs a build, rather than in production, where
# it would mean uploads silently failing open. A build with no embedded model
# answers CLEAN to everything, which is worse than no scanner — so refuse it,
# and print the loaded model's shape into the build log while we are at it.
RUN target/release/harbin --model-info > /tmp/model-info.txt \
 && if grep -q 'model: none' /tmp/model-info.txt; then \
      echo "harbin built without a detection model" >&2; exit 1; \
    fi \
 && cat /tmp/model-info.txt

FROM node:22-alpine

# pg_dump for the automatic S3 database backups, ffmpeg for the background
# media compressor. Malware scanning needs no packages at all any more: the
# engine is the self-contained binary copied in below (see the harbin stage),
# which is why the ~1 GB clamd container and its ~500 MB signature volume are
# gone. Uploads are staged in the temp dir while the engine reads them.
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
