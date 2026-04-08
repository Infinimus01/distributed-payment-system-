FROM node:18-alpine AS builder
WORKDIR /app
COPY services/payment-service/package.json ./
RUN npm install --omit=dev
COPY services/payment-service/src/ ./src/
COPY shared/ ./shared/

FROM node:18-alpine AS production
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001
WORKDIR /app
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/src ./src
COPY --from=builder --chown=nodejs:nodejs /app/shared ./shared
COPY --chown=nodejs:nodejs services/payment-service/package.json ./
USER nodejs
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)}).on('error', () => process.exit(1))"
CMD ["node", "src/index.js"]
