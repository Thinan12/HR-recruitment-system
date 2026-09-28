# LALCO HR — Postman API test suite

An executable test suite for every API route in the source (`src/app.js`, `src/routes/admin.js`, `src/routes/exam.js`).

| File | What it is |
|---|---|
| `LALCO-HR-Recruitment-System.postman_collection.json` | The collection (Postman v2.1): 19 folders, 271 requests, about 2,200 assertions per run |
| `environments/LALCO-HR-Local.postman_environment.json` | `baseUrl` = http://localhost:3000, `mode` = LOCAL |
| `environments/LALCO-HR-Production.postman_environment.json` | `baseUrl` = the Railway URL, `mode` = PRODUCTION |
| `fixtures/` | The files the upload requests attach, each with a known expected result |
| `tools/build-collection.js` | Generates the collection and environments. Edit this, not the JSON |
| `tools/make-fixtures.js` | Regenerates `fixtures/` |
| `tools/lint-collection.js` | Lint: schema, variables, URLs, a status test on every request, route coverage |

## Run it in Postman

1. **Import** the collection and both environments (File → Import).
2. Choose an environment. Enter **adminPassword** in it; the files ship with it empty.
3. Point Settings → General → **Working directory** at this `postman` folder, so the upload requests find `fixtures/…`.
4. Open the collection and choose **Run collection**. Run the whole collection in order: IDs, link tokens and candidate sessions are captured automatically as it goes.

Folder 14 waits 65 seconds for a 1-minute test to time out. Set `skipTimerTests` = `true` in the environment to skip it.

## Run it from the command line

```
npx newman@6.2.2 run postman/LALCO-HR-Recruitment-System.postman_collection.json \
  -e postman/environments/LALCO-HR-Local.postman_environment.json \
  --env-var adminPassword=YOUR_PASSWORD --working-dir postman
```

## Production-safe by design

- **Temporary data only.** Everything the run creates is named `POSTMAN TEST <timestamp> …`: candidates, links, test types, categories and questions. All test questions go into **temporary test types**, so a real candidate can never be given one.
- **The IQ scoring test** draws from the real IQ bank but only reads it. The link is temporary and only this run's candidates use it.
- **Cleanup** (folder 99) deletes only records whose names start with `POSTMAN TEST`, including leftovers from an interrupted run. It then checks that question counts, test types and categories are back to the baseline recorded after login.
- **Never called for real:**
  - *Delete All Questions:* only with an invalid test area, which the server refuses.
  - *Settings:* saved back with identical values.
  - *Translate Missing Lao:* skipped when a translation service is configured.
- **LOCAL only.** Requests marked "mode = LOCAL" are skipped unless `mode` is `LOCAL`. These are a real password change (to the same password) and seeding 10 IQ questions into an empty bank.
- **Candidate sessions.** Candidate requests turn the cookie jar off and send each candidate's own `lalco_candidate_session` cookie. That's how candidates A and B can share one link.

## Not covered

- **Internal Office Staff.** The feature has no routes in the source yet. Folder 17 is an empty placeholder.
- **Expired admin JWT.** It can't be forged without the server secret. Invalid and forged tokens are tested instead.

## After changing an API

```
node postman/tools/build-collection.js
node postman/tools/lint-collection.js <path-to-v2.1-schema.json>   # schema check needs: npm i --no-save ajv-draft-04
```
