'use strict';

const express = require('express');

const projects = require('./projects');
const supervisor = require('./supervisor');

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const router = express.Router();

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

module.exports = router;
