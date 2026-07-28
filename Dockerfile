# syntax=docker/dockerfile:1

# ---- web client build ----
FROM node:20-alpine AS web-build
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
RUN npm run build

# ---- backend build ----
FROM node:20-alpine AS backend-build
WORKDIR /app
# Alpine ships musl libc without OpenSSL by default; Prisma's query engine
# binary needs it and silently mis-detects the target without it.
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npx prisma generate

# ---- production image ----
# Ships the whole node_modules tree (including the prisma CLI, a
# devDependency) rather than a pruned production install, since the prisma
# CLI is needed at container startup to run migrations. Simpler and more
# reliable than juggling a separate prod-only install stage for a project
# this size.
FROM node:20-alpine AS production
WORKDIR /app
RUN apk add --no-cache openssl
ENV NODE_ENV=production
COPY --from=backend-build /app/node_modules ./node_modules
COPY --from=backend-build /app/dist ./dist
COPY --from=backend-build /app/prisma ./prisma
COPY package.json ./
COPY --from=web-build /web/dist ./web-dist
EXPOSE 8080
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
