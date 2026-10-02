// HR management of Result Viewer accounts (mounted at /api/admin/result-viewers,
// admin login required). Passwords are never shown again after they are set.
const express = require('express');
const RV = require('../resultViewers');

const router = express.Router();
const notFound = (res) => res.status(404).json({ error: 'Not found.' });
const handle = (fn) => (req, res) => {
  try {
    const out = fn(req, res);
    if (out === null) return notFound(res);
    if (out !== undefined) res.json(out);
  } catch (e) {
    if (e instanceof RV.ViewerError) return res.status(400).json({ error: e.message });
    throw e;
  }
};

router.get('/', (req, res) => res.json(RV.list()));
router.post('/', handle((req, res) => { res.status(201).json(RV.create(req.body || {}, req.admin.username)); }));
router.post('/:id/:action(enable|disable)', handle((req) => RV.setActive(req.params.id, req.params.action === 'enable', req.admin.username)));
router.post('/:id/password', handle((req) => RV.resetPassword(req.params.id, req.body?.password, req.admin.username)));
router.delete('/:id', handle((req) => RV.remove(req.params.id, req.admin.username)));

module.exports = router;
