'use strict';

const cfg = require('./integrationConfig');
const { getSettings } = require('./facilityIntegrationSettings');

function createIntegrationApiKeyMiddleware(pool) {
  return async function integrationApiKeyMiddleware(req, res, next) {
    try {
      const facilityId = parseFacilityId(req, req.body?.facility_id);
      const settings = await getSettings(pool, facilityId);
      if (settings.enabled === 0) {
        return res.status(403).json({ error: 'Integrations are disabled for this facility.' });
      }
      if (settings.api_enabled === 0) {
        return res.status(403).json({ error: 'Integration API access is disabled for this facility.' });
      }
      if (settings.hms_sync_enabled === 0) {
        return res.status(403).json({ error: 'HMS employee sync is disabled for this facility.' });
      }
      const expected = settings.hms_api_key_inbound || cfg.hmsInboundApiKey();
      const provided = String(req.headers['x-api-key'] || req.headers['X-API-Key'] || '').trim();
      if (!expected || provided !== expected) {
        return res.status(401).json({ error: 'Invalid API key.' });
      }
      req.integrationFacilityId = facilityId;
      next();
    } catch (e) {
      return res.status(500).json({ error: e.message || String(e) });
    }
  };
}

function parseFacilityId(req, bodyFacilityId = 0) {
  const header = parseInt(String(req.headers['x-facility-id'] || req.headers['X-Facility-Id'] || ''), 10);
  if (header > 0) return header;
  const body = parseInt(String(bodyFacilityId || ''), 10);
  return body > 0 ? body : 1;
}

function isExcludedEmployee(dto) {
  const role = String(dto.hms_role ?? '').trim();
  if (role === '1' || role === '99') return true;
  const email = String(dto.email || '').trim().toLowerCase();
  if (/^vd\d+@visiting\.local$/i.test(email)) return true;
  const username = String(dto.hms_username || '').trim();
  if (/^VD\d+$/i.test(username)) return true;
  const job = String(dto.job_title || '').toLowerCase();
  if (job.includes('visiting doctor')) return true;
  return dto.include_in_payroll === false;
}

async function upsertEmployee(pool, facilityId, dto) {
  const hmsId = parseInt(String(dto.hms_employee_id), 10) || 0;
  if (hmsId < 1) return { ok: false, error: 'hms_employee_id required' };

  if (dto.event === 'deleted' || dto.is_active === false || isExcludedEmployee(dto)) {
    await pool.query('UPDATE tbl_employee SET status = 0 WHERE id = ? LIMIT 1', [hmsId]).catch(() => {});
    return { ok: true, status: 'deactivated', hms_employee_id: hmsId };
  }

  const [[existing]] = await pool
    .query('SELECT id, username FROM tbl_employee WHERE id = ? LIMIT 1', [hmsId])
    .catch(() => [[null]]);

  const username = String(dto.hms_username || dto.email || `emp${hmsId}`).trim().slice(0, 64);
  const password = String(dto.password_hash || existing?.password || '$2a$10$changemereplacehashvalue000000000000000000000000000');
  const fields = {
    first_name: dto.first_name || '',
    last_name: dto.last_name || '',
    username,
    emailid: dto.email || '',
    employee_id: dto.employee_code || String(hmsId),
    joining_date: dto.hire_date ? String(dto.hire_date).slice(0, 10) : null,
    primary_department: dto.department || '',
    job_title: dto.job_title || '',
    role: parseInt(String(dto.hms_role || '2'), 10) || 2,
    status: dto.is_active === false ? 0 : 1,
    gender: dto.gender || '',
    phone: dto.phone || '',
    address: dto.address || '',
    bio: dto.bio || '',
  };

  if (existing) {
    await pool.query(
      `UPDATE tbl_employee SET first_name=?, last_name=?, username=?, emailid=?, employee_id=?, joining_date=?,
       primary_department=?, job_title=?, role=?, status=?, gender=?, phone=?, address=?, bio=?
       WHERE id=?`,
      [
        fields.first_name, fields.last_name, fields.username, fields.emailid, fields.employee_id,
        fields.joining_date, fields.primary_department, fields.job_title, fields.role, fields.status,
        fields.gender, fields.phone, fields.address, fields.bio, hmsId,
      ]
    );
    return { ok: true, status: 'updated', hms_employee_id: hmsId, created: false };
  }

  await pool.query(
    `INSERT INTO tbl_employee (
      id, first_name, last_name, username, emailid, password, employee_id, joining_date,
      primary_department, job_title, role, status, gender, phone, address, bio
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      hmsId, fields.first_name, fields.last_name, fields.username, fields.emailid, password,
      fields.employee_id, fields.joining_date, fields.primary_department, fields.job_title,
      fields.role, fields.status, fields.gender, fields.phone, fields.address, fields.bio,
    ]
  );
  return { ok: true, status: 'created', hms_employee_id: hmsId, created: true };
}

async function syncEmployeesBulk(pool, facilityId, dto) {
  const items = Array.isArray(dto.employees) ? dto.employees : [];
  let created = 0;
  let updated = 0;
  let deactivated = 0;

  for (const item of items) {
    const result = await upsertEmployee(pool, facilityId, item);
    if (!result.ok) continue;
    if (result.status === 'deactivated') deactivated++;
    else if (result.created) created++;
    else updated++;
  }

  if (dto.replace_all) {
    const syncedIds = items
      .map((i) => parseInt(String(i.hms_employee_id), 10))
      .filter((id) => id > 0);
    if (syncedIds.length) {
      const placeholders = syncedIds.map(() => '?').join(',');
      await pool
        .query(`UPDATE tbl_employee SET status = 0 WHERE id NOT IN (${placeholders}) AND role NOT IN (1, 99)`, syncedIds)
        .catch(() => {});
    }
  }

  return { status: 'synced', created, updated, deactivated, total: items.length };
}

module.exports = {
  createIntegrationApiKeyMiddleware,
  parseFacilityId,
  upsertEmployee,
  syncEmployeesBulk,
};
