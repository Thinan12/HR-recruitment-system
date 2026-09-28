// Lints the Postman collection. Run from the repository root:
//   node postman/tools/lint-collection.js [path/to/collection-v2.1-schema.json]
// Checks (errors unless noted):
//   - the collection against the official v2.1 JSON schema (when the schema file and
//     the ajv-draft-04 package are available: npm i --no-save ajv-draft-04)
//   - every {{variable}} used is defined in both environments
//   - url.raw agrees with url.host / url.path / url.query
//   - every request has a description, a test script and a status-code test
//   - request names are unique inside their folder
//   - every route in the source (src/app.js, src/routes/*.js; exam.js at both mount points) is called at least once
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPO = path.join(ROOT, '..');
const collection = JSON.parse(fs.readFileSync(path.join(ROOT, 'LALCO-HR-Recruitment-System.postman_collection.json'), 'utf8'));
const envs = ['LALCO-HR-Local', 'LALCO-HR-Production'].map((n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'env', n + '.postman_environment.json'), 'utf8')));
const errors = [];
const warnings = [];

// 1. JSON schema
const schemaPath = process.argv[2];
if (schemaPath) {
  try {
    const Ajv = require('ajv-draft-04');
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(JSON.parse(fs.readFileSync(schemaPath, 'utf8')));
    if (!validate(collection)) for (const e of validate.errors) errors.push(`schema: ${e.instancePath} ${e.message}`);
    else console.log('schema: valid against the Postman Collection v2.1 schema');
  } catch (e) { warnings.push('schema check not run: ' + e.message); }
} else warnings.push('schema check not run (pass the path of the v2.1 schema file)');

// 2-5. requests
const envKeys = envs.map((e) => new Set(e.values.map((v) => v.key)));
const called = [];
const walk = (items, where) => {
  const names = new Set();
  for (const it of items) {
    const at = `${where}/${it.name}`;
    if (names.has(it.name)) errors.push(`duplicate name in folder: ${at}`);
    names.add(it.name);
    if (it.item) { walk(it.item, at); continue; }
    const r = it.request;
    if (!r.description || r.description.length < 40) errors.push(`no description: ${at}`);
    const test = (it.event || []).find((e) => e.listen === 'test');
    if (!test || !test.script.exec.some((l) => /pm\.test\('Status is/.test(l))) errors.push(`no status test: ${at}`);
    // url consistency
    const u = r.url;
    const rebuilt = u.host.join('.') + '/' + u.path.join('/') + (u.query && u.query.length ? '?' + u.query.map((q) => `${q.key}=${q.value}`).join('&') : '');
    if (rebuilt !== u.raw) errors.push(`url mismatch: ${at}\n    raw:     ${u.raw}\n    rebuilt: ${rebuilt}`);
    // variables used anywhere in the request definition must exist in both environments
    const text = JSON.stringify(r);
    for (const m of text.matchAll(/\{\{(\w+)\}\}/g)) {
      const scriptLocal = (it.event || []).some((e) => e.script.exec.some((l) => l.includes(`pm.variables.set('${m[1]}'`)));
      if (!scriptLocal && !envKeys.every((k) => k.has(m[1]))) errors.push(`undefined variable {{${m[1]}}} in ${at}`);
    }
    // scripts: variables read with env('x') / getJSON('x') should exist too (warning: some are set at run time)
    for (const e of it.event || []) for (const l of e.script.exec) for (const m of l.matchAll(/(?:env|getJSON)\('(\w+)'\)/g)) {
      if (!envKeys.every((k) => k.has(m[1]))) warnings.push(`script reads ${m[1]} (not declared in the environments): ${at}`);
    }
    called.push({ method: r.method, path: '/' + u.path.join('/') });
  }
};
walk(collection.item, '');

// 6. route coverage
const routes = [];
// exam.js is mounted twice: recruitment (/api/exam) and internal staff (/api/internal-exam).
for (const [file, prefix] of [['src/app.js', ''], ['src/routes/admin.js', '/api/admin'], ['src/routes/internal.js', '/api/admin/internal'], ['src/routes/exam.js', '/api/exam'], ['src/routes/exam.js', '/api/internal-exam']]) {
  const src = fs.readFileSync(path.join(REPO, file), 'utf8');
  for (const m of src.matchAll(/(?:router|app)\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
    if (file === 'src/app.js' && !m[2].startsWith('/api')) continue; // pages, not API
    routes.push({ method: m[1].toUpperCase(), path: prefix + m[2] });
  }
}
// Express pattern -> regex (":id", ":action(enable|disable)", ".:format").
const toRegex = (p) => new RegExp('^' + p.replace(/[.]/g, '\\.').replace(/:(\w+)\(([^)]+)\)/g, '($2)').replace(/:(\w+)/g, '[^/]+') + '$');
const uncovered = [];
for (const r of routes) {
  const re = toRegex(r.path);
  const hits = called.filter((c) => c.method === r.method && re.test(c.path.replace(/\{\{\w+\}\}/g, 'x')));
  if (!hits.length) uncovered.push(`${r.method} ${r.path}`);
}
if (uncovered.length) for (const u of uncovered) errors.push('route not covered: ' + u);

const requests = called.length;
console.log(`routes in the source: ${routes.length} (API routes with their method), requests: ${requests}`);
for (const w of [...new Set(warnings)]) console.log('warning:', w);
for (const e of errors) console.log('error:', e);
console.log(`\n${errors.length} errors, ${new Set(warnings).size} warnings`);
process.exit(errors.length ? 1 : 0);
