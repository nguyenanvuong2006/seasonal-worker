# Document Merge PDF Worker — production Dockerfile
# Base image Playwright đã kèm Chromium + system deps → không cần npx playwright install.

# Keep the image browser revision aligned with the locked `playwright` package.
# playwright@1.62.1 expects Chromium revision 1234.
FROM mcr.microsoft.com/playwright:v1.62.1-noble AS deps
WORKDIR /app
COPY worker/package.json worker/package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM mcr.microsoft.com/playwright:v1.62.1-noble
WORKDIR /app

# node_modules (playwright + drizzle + pg + tsx)
COPY --from=deps /app/node_modules ./node_modules

# Shared app source (được import qua alias @/* bởi worker)
COPY src ./src
# Worker source + tsconfig (paths @/* -> ../src/*)
COPY worker/src ./worker/src
COPY worker/tsconfig.json ./tsconfig.json
COPY worker/package.json ./package.json

# Chromium: không chạy sandbox (Cloud Run container không cấp SYS_ADMIN)
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# Giữ index.ts tại worker/src; tsx chạy trực tiếp TS + resolve tsconfig paths.
CMD ["node", "--import", "tsx", "worker/src/index.ts"]
