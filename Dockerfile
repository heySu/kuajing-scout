# 零依赖：不需要 npm install，镜像只复制源码
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3600 \
    DB_PATH=/app/data/scout.db \
    TZ_NAME=Asia/Shanghai \
    REPORT_WRITE_FILES=0

COPY package.json ./
COPY server ./server
COPY public ./public

RUN mkdir -p /app/data /app/reports && chown -R node:node /app
USER node

EXPOSE 3600
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3600)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "--experimental-sqlite", "--disable-warning=ExperimentalWarning", "server/index.js"]
