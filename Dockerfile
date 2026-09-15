# Campfire app image.
#
# Malware scanning is NOT built into this image. It is ClamAV, running as its own
# `clamav/clamav` container (see docker-compose.yml), which this app drives over
# TCP with `INSTREAM` (clamav.js): a signature engine needs a database on disk, a
# downloader on a schedule and a daemon holding the database in RAM, and none of
# that belongs in the app's image or its process. Uploads are streamed to the
# daemon, so the two containers share no volume and the daemon never needs to see
# a path in this one.
FROM node:22-alpine

# pg_dump for the automatic S3 database backups, ffmpeg for the background
# media compressor. Nothing is installed for scanning: the engine lives in the
# clamav service, and this container only opens a socket to it.
#
# libheif-tools is what makes a HEIC/HEIF upload viewable: Alpine's ffmpeg is
# built WITHOUT libheif, so this image has no HEIF demuxer at all — and no
# browser (or Windows viewer) can decode those bytes either, which left an
# iPhone photo as a download nobody could open. `heif-convert` decodes one to a
# JPEG that the still pipeline then downsizes and re-encodes like any other
# photo (see media-compress.js: planFor/encodeCandidate, and checkHeifConvert,
# which the worker probes at boot and reports in its startup line).
RUN apk add --no-cache postgresql-client ffmpeg libheif-tools

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY . .
RUN node scripts/gen-icons.js

ENV NODE_ENV=production \
    PORT=3000 \
    # The compose service name; CLAMAV_HOST/PORT are what clamav.js dials.
    CLAMAV_HOST=clamav \
    CLAMAV_PORT=3310 \
    # The probe also scans the EICAR string against the running daemon and
    # refuses a daemon that does not detect it. A ClamAV whose database failed to
    # load answers OK to everything, which is worse than no scanner because it is
    # believed — so it is proved at startup, not assumed. (In the compose file
    # too, so an operator can see it.)
    CLAMAV_VERIFY_EICAR=1

VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "server.js"]
