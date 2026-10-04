FROM node:20-alpine

# better-sqlite3 needs build tools, and sslTools needs openssl CLI
RUN apk add --no-cache openssl python3 make g++

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
