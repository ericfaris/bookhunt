'use strict';

// One Server-Sent-Events response (search, batch search, download). Long
// scrapes and downloads go silent between page loads for longer than
// Cloudflare's 100s proxy timeout, so every stream sends a comment-frame
// heartbeat; `data: {…}` frames carry the events.

const HEARTBEAT_MS = 15000;

/**
 * Start an SSE response. Returns:
 *   send(event)        — write one JSON event (no-op once ended)
 *   onClientGone(fn)   — fn runs only when the CLIENT disconnects mid-stream.
 *                        Listens on the RESPONSE close: req 'close' also fires
 *                        when the request body has been read (early, behind
 *                        Cloudflare), which would cancel every stream.
 *   end()              — stop the heartbeat and finish the response
 */
function openSSE(res, { heartbeatMs = HEARTBEAT_MS } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable proxy buffering so events flush promptly
  });
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, heartbeatMs);
  res.on('close', () => clearInterval(heartbeat));
  return {
    send(event) {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    onClientGone(fn) {
      res.on('close', () => { if (!res.writableEnded) fn(); });
    },
    end() {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    },
  };
}

module.exports = { openSSE, HEARTBEAT_MS };
