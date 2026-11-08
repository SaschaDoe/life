// Server-Sent Events: tells open apps "something changed, reload".
const clients = new Set();

export function sseHandler(req, res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

export function broadcast(type, extra = {}) {
  const msg = `data: ${JSON.stringify({ type, ...extra })}\n\n`;
  for (const c of clients) c.write(msg);
}

setInterval(() => {
  for (const c of clients) c.write(': ping\n\n');
}, 25000).unref();
