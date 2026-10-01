FROM node:22-alpine

WORKDIR /app
COPY scripts/*.mjs scripts/

ENV COPILOT_PROXY_HOST=0.0.0.0 \
    COPILOT_PROXY_PORT=18080

EXPOSE 18080

CMD ["node", "scripts/proxy.mjs"]
