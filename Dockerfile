# syntax=docker/dockerfile:1.7

FROM --platform=${BUILDPLATFORM} node:22.22.0-alpine3.22@sha256:7aa86fa052f6e4b101557ccb56717cb4311be1334381f526fe013418fe157384 AS build

ARG VITE_CONSOLE_DATA_MODE=fixture
ARG VITE_CONSOLE_AUTH_MODE=prototype

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

FROM --platform=${TARGETPLATFORM} gcr.io/distroless/nodejs22-debian13:nonroot@sha256:4e4fb0ce55fd73901600796ef079a9490369d2515d7da31633a91608c82ca13b AS runtime

ARG VCS_REF=unknown
ARG VITE_CONSOLE_DATA_MODE=fixture
ARG VITE_CONSOLE_AUTH_MODE=prototype
LABEL org.opencontainers.image.source="https://github.com/openkubes/ok-console" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.title="OpenKubes Console" \
      io.openkubes.console.data-mode="${VITE_CONSOLE_DATA_MODE}" \
      io.openkubes.console.auth-mode="${VITE_CONSOLE_AUTH_MODE}"

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
