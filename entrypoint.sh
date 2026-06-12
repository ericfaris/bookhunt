#!/bin/sh
# Container entrypoint: bring up a virtual display so Chromium runs HEADED (which
# Mobilism's Cloudflare lets through), expose that live browser over VNC/noVNC so
# it can be warmed remotely via /warm, then start the app. All of this runs as
# the non-root container user.
set -e

export DISPLAY="${DISPLAY:-:99}"
SCREEN="${XVFB_SCREEN:-1280x900x24}"
DNUM="${DISPLAY#:}"

# Clear state left over from a previous boot/crash so startup is idempotent:
#  - a stale X lock/socket makes Xvfb refuse to start ("already active")
#  - a stale Chromium SingletonLock makes the browser refuse to launch
# This container is the sole user of the profile, so removing them is safe.
echo "[entrypoint] clearing stale X + Chromium locks"
rm -f "/tmp/.X${DNUM}-lock" "/tmp/.X11-unix/X${DNUM}" 2>/dev/null || true
rm -f /app/.browser-profile/Singleton* 2>/dev/null || true

echo "[entrypoint] starting Xvfb on $DISPLAY ($SCREEN)"
Xvfb "$DISPLAY" -screen 0 "$SCREEN" -nolisten tcp >/tmp/xvfb.log 2>&1 &

# Wait for the X socket to come up before launching anything that needs it.
for i in $(seq 1 50); do
  [ -e "/tmp/.X11-unix/X${DISPLAY#:}" ] && break
  sleep 0.1
done

echo "[entrypoint] starting fluxbox window manager"
fluxbox >/tmp/fluxbox.log 2>&1 &

echo "[entrypoint] starting x11vnc (localhost only) on :5900"
# -localhost: only reachable from inside the container (websockify bridges it).
# -nopw is safe here: the only public path is /warm, gated by Cloudflare Access.
x11vnc -display "$DISPLAY" -nopw -localhost -forever -shared -rfbport 5900 \
  -noxdamage -ncache 0 >/tmp/x11vnc.log 2>&1 &

echo "[entrypoint] starting noVNC/websockify on :6080 -> :5900"
websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/websockify.log 2>&1 &

echo "[entrypoint] starting app"
exec node src/server.js
