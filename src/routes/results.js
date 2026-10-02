// Result Viewer API (mounted at /api/results): log in, log out, and read the
// logged-in person's OWN results. Read only. The person always comes from the
// account on the server; ids in the URL or query are never used.
const express = require('express');
const RV = require('../resultViewers');

const router = express.Router();
const fileName = (name) => String(name || 'result').replace(/[^\p{L}\p{N}\- ]+/gu, '').trim().replace(/\s+/g, '_') || 'result';

router.post('/auth/login', RV.login);
router.post('/auth/logout', RV.logout);

router.use(RV.requireViewer);

router.get('/me', (req, res) => {
  const data = RV.resultsFor(req.viewer);
  if (!data) return res.status(404).json({ error: 'No results were found for this account. Please contact HR.' });
  res.json({ username: req.viewer.username, ...data });
});

router.get('/me/export.xlsx', async (req, res, next) => {
  try {
    const data = RV.resultsFor(req.viewer);
    if (!data) return res.status(404).json({ error: 'No results were found for this account. Please contact HR.' });
    const name = `LALCO_My_Results_${fileName(data.candidateName)}.xlsx`;
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.set('Cache-Control', 'no-store');
    res.send(await RV.resultsXlsx(data));
  } catch (e) { next(e); }
});

// Anything else here does not exist (a Result Viewer has nothing else to reach).
router.use((req, res) => res.status(404).json({ error: 'Not found.' }));

module.exports = router;
