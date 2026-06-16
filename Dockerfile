FROM node:22-slim

WORKDIR /app

# Install browsers to a shared, world-readable path so the container can run as
# a non-root user (uid 1000) and still launch Chromium.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Virtual display + remote-view stack so Chromium can run HEADED inside the
# container (Mobilism's Cloudflare blocks headless) and be warmed via noVNC:
#   xvfb      - virtual X display
#   fluxbox   - minimal window manager (so the browser window behaves normally)
#   x11vnc    - exposes the virtual display over VNC
#   novnc + websockify - browser-based VNC client served over HTTP/WebSocket
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb fluxbox x11vnc novnc websockify \
    && rm -rf /var/lib/apt/lists/* \
    # Xvfb writes its socket here; make it world-writable for the non-root user.
    && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

COPY package*.json ./
RUN npm ci --omit=dev

# --with-deps installs the OS libraries Chromium needs (runs as root at build).
RUN node_modules/.bin/playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright

COPY src/ ./src/
COPY public/ ./public/
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# Stamp the build identity into the image (version comes from package.json at
# runtime; these pin the exact commit + build time the image was built from).
# Passed by docker-compose build args / the `docker:up` npm script.
ARG GIT_SHA=""
ARG BUILD_TIME=""
ENV GIT_SHA=$GIT_SHA \
    BUILD_TIME=$BUILD_TIME

ENV PORT=3000 \
    HOST=0.0.0.0 \
    DOWNLOAD_PATH=/downloads \
    DISPLAY=:99 \
    HOME=/tmp

EXPOSE 3000

ENTRYPOINT ["./entrypoint.sh"]
