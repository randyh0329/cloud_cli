'use strict';

const express = require('express');
const multer = require('multer');

const config = require('./config');
const projects = require('./projects');
const screenshots = require('./screenshots');
const supervisor = require('./supervisor');
const { HttpError } = require('./errors');

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const router = express.Router();

/**
 * Uploads are held in memory, never in a temp file: screenshots.js decides the
 * destination filename from the *bytes*, and a rejected upload should leave
 * nothing on disk at all.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.MAX_UPLOAD_BYTES,
    files: 1,
    fields: 4,
    parts: 6,
    fieldNameSize: 64,
    fieldSize: 256,
  },
}).single('file');

/** Turn multer's limit errors into the app's own HTTP error shape. */
const uploadMiddleware = (req, res, next) =>
  upload(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      const mb = (config.MAX_UPLOAD_BYTES / (1024 * 1024)).toFixed(0);
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? `image is larger than the ${mb} MB limit`
          : `bad multipart upload: ${err.message} (${err.code})`;
      return next(new HttpError(status, message));
    }
    return next(err);
  });

router.get(
  '/health',
  asyncRoute(async (_req, res) => {
    const pf = await supervisor.preflight();
    // Always 200 — the app is up. `ok` reports whether it can actually start
    // terminals, which is what the UI needs to know.
    res.json({ ok: pf.ok, supervisor: pf });
  })
);

router.get(
  '/projects',
  asyncRoute(async (_req, res) => {
    res.json({ projects: await projects.list() });
  })
);

router.get(
  '/projects/:slug',
  asyncRoute(async (req, res) => {
    res.json(await projects.getOne(req.params.slug));
  })
);

router.post(
  '/projects',
  asyncRoute(async (req, res) => {
    const project = await projects.create(req.body);
    res.status(201).json(project);
  })
);

router.delete(
  '/projects/:slug',
  asyncRoute(async (req, res) => {
    res.json(await projects.remove(req.params.slug));
  })
);

router.post(
  '/upload',
  uploadMiddleware,
  asyncRoute(async (req, res) => {
    res.json(await screenshots.upload({ project: req.body.project, file: req.file }));
  })
);

module.exports = router;
