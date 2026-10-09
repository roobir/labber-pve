# syntax=docker/dockerfile:1

# Build stage: always runs on the machine doing the build (never emulated),
# whatever platform the image is being built FOR. That is safe because every
# dependency here is plain JavaScript (no native addons), and it avoids running
# Node under QEMU when cross-building the arm64 image, which is slow and has
# crashed with "Illegal instruction" on CI runners.
FROM --platform=$BUILDPLATFORM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY lib ./lib
COPY routes ./routes
COPY public ./public
COPY runbooks ./runbooks

# OpenShift's restricted SCC runs containers as an arbitrary, unpredictable
# UID but always keeps them in the root group (gid 0) -- group-own
# everything and make it group-writable so that works, rather than assuming
# a fixed UID the way plain Docker/Podman/vanilla k3s would tolerate.
RUN mkdir -p /labs/.state && \
    chgrp -R 0 /app /labs && \
    chmod -R g=u /app /labs

# Final image: just the files above (ownership and permissions are carried
# over by COPY), so there is no RUN step left to emulate on another platform.
FROM node:20-alpine

WORKDIR /app

COPY --from=build /app /app
COPY --from=build /labs /labs

ENV LABS_DIR=/labs
VOLUME /labs

EXPOSE 8080

# Respected as-is under Docker/Podman/k3s; OpenShift substitutes its own
# random UID at deploy time regardless of this line -- the chgrp/chmod above
# is what actually makes both cases work, not this USER directive itself.
USER 1001

CMD ["node", "server.js"]
