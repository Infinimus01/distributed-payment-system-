FROM node:18-alpine AS builder
WORKDIR /app
COPY services/api-gateway/package.json ./
RUN npm install --omit=dev
COPY services/api-gateway/src/ ./src/
COPY shared/ ./shared/

FROM node:18-alpine AS production
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001
WORKDIR /app
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/src ./src
COPY --from=builder --chown=nodejs:nodejs /app/shared ./shared
COPY --chown=nodejs:nodejs services/api-gateway/package.json ./
USER nodejs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)}).on('error', () => process.exit(1))"
CMD ["node", "src/index.js"]
