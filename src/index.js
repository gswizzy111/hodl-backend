require('dotenv').config();

const express = require('express');
const app     = express();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(express.json());

// Simple request logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.use('/users',    require('./routes/users'));
app.use('/holdings', require('./routes/holdings'));
app.use('/alerts',   require('./routes/alerts'));
app.use('/digest',   require('./routes/digest'));
app.use('/api/news', require('./routes/news'));

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ---------------------------------------------------------------------------
// Cron jobs
// ---------------------------------------------------------------------------

const breakingAlerts = require('./jobs/breakingAlerts');
const nightlyDigest  = require('./jobs/nightlyDigest');
const newsRefresh    = require('./jobs/newsRefresh');

breakingAlerts.schedule();
nightlyDigest.schedule();
newsRefresh.schedule();

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const PORT = process.env.PORT ?? 3000;

const server = app.listen(PORT, () => {
  console.log(`[server] HODL backend listening on port ${PORT}`);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(signal) {
  console.log(`[server] ${signal} received — shutting down`);
  const { shutdown: apnsShutdown } = require('./services/apns');
  apnsShutdown();
  server.close(() => {
    console.log('[server] HTTP server closed');
    process.exit(0);
  });
  // Force-exit if graceful shutdown takes too long
  setTimeout(() => process.exit(1), 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
