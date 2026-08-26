'use strict';

const path = require('path');
const express = require('express');

const config = require('./config');
const apiRoutes = require('./routes');
const proxy = require('./proxy');
const { HttpError, notFound } = require('./errors');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  // The proxy must come before express.json(): the body parser would consume
  // the request stream, leaving nothing to forward to ttyd. It only claims
  // /term/*, and calls next() for everything else.
  app.use(proxy.httpMiddleware);

  app.use(express.json({ limit: '64kb' }));

  app.use('/api', apiRoutes);

  app.use(express.static(PUBLIC_DIR, { index: 'index.html', extensions: ['html'] }));

  app.use((req, _res, next) => {
    next(notFound(`no route for ${req.method} ${req.path}`));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const known = err instanceof HttpError;
    const status = known ? err.status : 500;
    // Deliberate HttpErrors are expected control flow — log one line, no stack.
    // Anything else is a bug and gets the full trace.
    if (!known) console.error(`[error] ${req.method} ${req.originalUrl}`, err);
    else if (status >= 500) console.warn(`[${status}] ${req.method} ${req.originalUrl}: ${err.message}`);
    if (res.headersSent) return;
    const body = { error: err.message || 'internal error' };
    if (err.detail !== undefined) body.detail = err.detail;
    res.status(status).json(body);
  });

  return app;
}

module.exports = { createApp, PUBLIC_DIR, config };
