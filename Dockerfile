# Chipzen container image — Mimaima699.
#
# Uses the esbuild bundle (dist/bot.js: SDK + engine inlined, zero npm deps)
# so the build needs NO network beyond pulling the base image once.
#
# Platform contract (DEV-MANUAL §Container):
#   - ENTRYPOINT launched with CHIPZEN_WS_URL / CHIPZEN_TOKEN in env
#   - caps: 200MB image, 0.5 CPU, 256MB RAM  (this image ≈ 130MB)

# Pulled via DaoCloud's public mirror — auth.docker.io is unreachable from
# mainland China networks. Same official library/node image bits.
FROM docker.m.daocloud.io/library/node:20-alpine

WORKDIR /app
COPY dist/bot.js ./bot.js

# Non-root, tini-less: node is PID 1 and handles SIGTERM fine for this workload
USER node

ENTRYPOINT ["node", "/app/bot.js"]
