FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

# 섹터·종목 구성은 이 폴더에 저장된다 (NAS 폴더와 연결)
ENV DATA_DIR=/app/data
VOLUME ["/app/data"]

EXPOSE 3000
CMD ["node", "src/server.js"]
