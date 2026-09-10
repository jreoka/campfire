FROM node:22-alpine

# pg_dump for the automatic S3 database backups (no build tools needed).
RUN apk add --no-cache postgresql-client

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
