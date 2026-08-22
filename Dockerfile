# syntax=docker/dockerfile:1.7

FROM --platform=${BUILDPLATFORM} node:22.22.0-alpine3.22@sha256:7aa86fa052f6e4b101557ccb56717cb4311be1334381f526fe013418fe157384 AS build

WORKDIR /workspace
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json eslint.config.js ./
COPY public ./public
COPY src ./src
COPY bff ./bff
COPY contracts ./contracts
RUN pnpm build \
    && pnpm prune --prod \
    && test -z "$(find node_modules -type f -name '*.node' -print -quit)"

FROM --platform=${TARGETPLATFORM} gcr.io/distroless/nodejs22-debian13:nonroot@sha256:22d2f0480e59548ad14cf10d8921b24ef809780e7a61b162838f3d15a4a92e3d AS runtime

ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/openkubes/ok-console" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.title="OpenKubes Console"

ENV NODE_ENV=production \
    OK_CONSOLE_BFF_HOST=0.0.0.0 \
    OK_CONSOLE_BFF_PORT=8787

WORKDIR /app
COPY --chown=1000:1000 --from=build /workspace/package.json ./package.json
COPY --chown=1000:1000 --from=build /workspace/node_modules ./node_modules
COPY --chown=1000:1000 --from=build /workspace/bff ./bff
COPY --chown=1000:1000 --from=build /workspace/dist ./dist

USER 1000:1000
EXPOSE 8787
STOPSIGNAL SIGTERM
CMD ["bff/server.mjs"]
