# syntax=docker/dockerfile:1.7

FROM node:22.19.0-alpine3.22@sha256:d2166de198f26e17e5a442f537754dd616ab069c47cc57b889310a717e0abbf9 AS build

WORKDIR /workspace
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json eslint.config.js ./
COPY public ./public
COPY src ./src
COPY bff ./bff
COPY contracts ./contracts
RUN pnpm build && pnpm prune --prod

FROM node:22.19.0-alpine3.22@sha256:d2166de198f26e17e5a442f537754dd616ab069c47cc57b889310a717e0abbf9 AS runtime

ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/openkubes/ok-console" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.title="OpenKubes Console"

ENV NODE_ENV=production \
    OK_CONSOLE_BFF_HOST=0.0.0.0 \
    OK_CONSOLE_BFF_PORT=8787

WORKDIR /app
COPY --chown=node:node --from=build /workspace/package.json ./package.json
COPY --chown=node:node --from=build /workspace/node_modules ./node_modules
COPY --chown=node:node --from=build /workspace/bff ./bff
COPY --chown=node:node --from=build /workspace/dist ./dist

USER node
EXPOSE 8787
STOPSIGNAL SIGTERM
CMD ["node", "bff/server.mjs"]
