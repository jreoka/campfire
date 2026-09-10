FROM node:22-alpine

# pg_dump for the automatic S3 database backups, ffmpeg for the
# background media compressor, ClamAV (daemon + scanner + unrar support)
# for upload virus scanning (signature DBs download to CLAM_DB_DIR on
# first boot; ~1GB RAM for clamd — see .env.example).
RUN apk add --no-cache postgresql-client ffmpeg clamav-daemon clamav-scanner clamav-libunrar

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY . .
RUN node scripts/gen-icons.js

ENV NODE_ENV=production \
    PORT=3000

VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "server.js"]
