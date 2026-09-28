// Internal Office Staff: existing employees who take assessments. Their
// records live in internal_staff, never in candidates (recruitment). The
// assessment engine is shared; every link and attempt of this area has
// business_area = 'INTERNAL_STAFF'.
const { db, now, audit } = require('./db');

const AREA = 'INTERNAL_STAFF';
const RECRUITMENT = 'RECRUITMENT';
const FIELDS = ['name', 'employee_id', 'phone', 'email', 'department', 'position'];
const STATUSES = ['Active', 'Inactive'];

class StaffError extends Error {}

// Employee IDs are compared ignoring case and spaces ("emp 001" = "EMP001").
const employeeKey = (v) => String(v ?? '').toUpperCase().replace(/\s+/g, '');
const clean = (v, max = 200) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

function cleanStaff(body, { partial = false } = {}) {
  const s = {};
  for (const f of FIELDS) s[f] = clean(body?.[f], f === 'email' ? 254 : 200);
  if (!s.name) throw new StaffError('Staff name is required.');
  if (!s.employee_id) throw new StaffError('Employee ID is required.');
  if (s.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email)) throw new StaffError('Please enter a valid email address.');
  s.status = STATUSES.includes(body?.status) ? body.status : partial ? undefined : 'Active';
  return s;
}

const byId = (id) => db.prepare('SELECT * FROM internal_staff WHERE id = ?').get(Number(id));
const byEmployee = (employeeId) => db.prepare('SELECT * FROM internal_staff WHERE employee_key = ?').get(employeeKey(employeeId));

// A staff record with its assessment counts and latest result.
function withStats(s) {
  if (!s) return null;
  const counts = db.prepare(`SELECT COUNT(*) AS assessments, SUM(status = 'SUBMITTED') AS completed, SUM(status = 'IN_PROGRESS') AS in_progress,
    MAX(COALESCE(submitted_at, started_at)) AS last_assessment_at FROM assessments WHERE staff_id = ? AND business_area = ?`).get(s.id, AREA);
  const last = db.prepare(`SELECT result, status FROM assessments WHERE staff_id = ? AND business_area = ? AND status = 'SUBMITTED'
    ORDER BY submitted_at DESC, id DESC LIMIT 1`).get(s.id, AREA);
  return { ...s, assessments: counts.assessments, completed: counts.completed || 0, in_progress: counts.in_progress || 0,
    last_assessment_at: counts.last_assessment_at, last_result: last ? last.result : null };
}

// List with search (name, employee ID, phone, email) and filters (department, position, status).
function list({ q, department, status, position } = {}) {
  const where = [];
  const args = [];
  if (q) { where.push('(name LIKE ? OR employee_id LIKE ? OR phone LIKE ? OR email LIKE ?)'); args.push(...Array(4).fill(`%${q}%`)); }
  if (department) { where.push('department = ?'); args.push(department); }
  if (position) { where.push('position = ?'); args.push(position); }
  if (STATUSES.includes(status)) { where.push('status = ?'); args.push(status); }
  return db.prepare(`SELECT * FROM internal_staff ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY name COLLATE NOCASE, id`).all(...args).map(withStats);
}

// Distinct departments / positions (for the filters).
const departments = () => db.prepare("SELECT DISTINCT department FROM internal_staff WHERE department != '' ORDER BY department COLLATE NOCASE").all().map((r) => r.department);
const positions = () => db.prepare("SELECT DISTINCT position FROM internal_staff WHERE position != '' ORDER BY position COLLATE NOCASE").all().map((r) => r.position);

function create(body, actor) {
  const s = cleanStaff(body);
  if (byEmployee(s.employee_id)) throw new StaffError(`Employee ID "${s.employee_id}" is already used by another staff member.`);
  const stamp = now();
  const id = db.prepare(`INSERT INTO internal_staff (name, employee_id, employee_key, phone, email, department, position, status, created_at, updated_at)
    VALUES (@name, @employee_id, @key, @phone, @email, @department, @position, @status, @stamp, @stamp)`).run({ ...s, key: employeeKey(s.employee_id), stamp }).lastInsertRowid;
  audit('STAFF_CREATED', actor, { staff_id: id });
  return withStats(byId(id));
}

function update(id, body, actor) {
  const before = byId(id);
  if (!before) return null;
  const s = cleanStaff(body, { partial: true });
  const other = byEmployee(s.employee_id);
  if (other && other.id !== before.id) throw new StaffError(`Employee ID "${s.employee_id}" is already used by another staff member.`);
  db.prepare(`UPDATE internal_staff SET name = @name, employee_id = @employee_id, employee_key = @key, phone = @phone, email = @email,
    department = @department, position = @position, status = @status, updated_at = @stamp WHERE id = @id`)
    .run({ ...s, status: s.status || before.status, key: employeeKey(s.employee_id), stamp: now(), id: before.id });
  audit('STAFF_UPDATED', actor, { staff_id: before.id });
  return withStats(byId(before.id));
}

// Deletes a staff record and (like a recruitment candidate) their attempts.
function remove(id, actor) {
  const s = byId(id);
  if (!s) return null;
  db.prepare('DELETE FROM internal_staff WHERE id = ?').run(s.id);
  audit('STAFF_DELETED', actor, { staff_id: s.id });
  return { ok: true };
}

// What an employee types on the internal link (the public start form).
function cleanStartInfo(body) {
  const info = {};
  for (const f of FIELDS) info[f] = clean(body?.[f], f === 'email' ? 254 : 200);
  // Error codes (not sentences): the page shows them in its own language.
  const { InputError } = require('./assessments');
  if (!info.name) throw new InputError('name_required');
  if (!info.employee_id) throw new InputError('employee_id_required');
  if (info.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(info.email)) throw new InputError('email_invalid');
  return info;
}

// The staff record for an employee starting an internal assessment: the one HR
// created with that Employee ID (only its empty fields are filled in), or a new one.
function forStart(info) {
  const stamp = now();
  const found = byEmployee(info.employee_id);
  if (found) {
    const fill = Object.fromEntries(FIELDS.filter((f) => f !== 'employee_id').map((f) => [f, found[f] || info[f]]));
    db.prepare('UPDATE internal_staff SET name = @name, phone = @phone, email = @email, department = @department, position = @position, updated_at = @stamp WHERE id = @id')
      .run({ ...fill, stamp, id: found.id });
    return found.id;
  }
  return db.prepare(`INSERT INTO internal_staff (name, employee_id, employee_key, phone, email, department, position, status, created_at, updated_at)
    VALUES (@name, @employee_id, @key, @phone, @email, @department, @position, 'Active', @stamp, @stamp)`).run({ ...info, key: employeeKey(info.employee_id), stamp }).lastInsertRowid;
}

module.exports = { AREA, RECRUITMENT, FIELDS, STATUSES, StaffError, employeeKey, byId, withStats, list, departments, positions, create, update, remove, cleanStartInfo, forStart };
