FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY lib ./lib
COPY routes ./routes
COPY public ./public

# OpenShift's restricted SCC runs containers as an arbitrary, unpredictable
# UID but always keeps them in the root group (gid 0) -- group-own
# everything and make it group-writable so that works, rather than assuming
# a fixed UID the way plain Docker/Podman/vanilla k3s would tolerate.
RUN mkdir -p /labs/.state && \
    chgrp -R 0 /app /labs && \
    chmod -R g=u /app /labs

ENV LABS_DIR=/labs
VOLUME /labs

EXPOSE 8080

# Respected as-is under Docker/Podman/k3s; OpenShift substitutes its own
# random UID at deploy time regardless of this line -- the chgrp/chmod above
# is what actually makes both cases work, not this USER directive itself.
USER 1001

CMD ["node", "server.js"]
