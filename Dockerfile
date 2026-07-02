FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache git

COPY package.json ./
COPY cli.js ./
COPY templates ./templates
COPY scripts/poc-smoke.js ./scripts/poc-smoke.js

RUN chmod +x /app/cli.js

ENTRYPOINT ["node", "/app/cli.js"]
CMD ["--help"]
