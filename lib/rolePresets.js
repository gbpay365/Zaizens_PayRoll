'use strict';

/**
 * Popular job roles per collective-agreement sector. They are seeded into
 * tbl_role on demand so the new-employee Role dropdown speaks the language of
 * the business (a mine does not hire nurses), and HR can still add any role
 * that is missing.
 */
const ROLE_PRESETS = {
  mining: [
    'Admin',
    'Super Admin',
    'Mine Manager',
    'Mining Engineer',
    'Geologist',
    'Mine Surveyor',
    'Blasting Supervisor',
    'Drill Operator',
    'Heavy Equipment Operator',
    'Haul Truck Driver',
    'Processing Plant Operator',
    'Metallurgist',
    'Maintenance Technician',
    'Electrician',
    'Welder',
    'HSE Officer',
    'Environmental Officer',
    'Site Supervisor',
    'Security Officer',
    'General Labourer',
  ],
};

function rolesForSector(sector) {
  const key = String(sector || '').trim().toLowerCase();
  return ROLE_PRESETS[key] ? ROLE_PRESETS[key].slice() : [];
}

module.exports = { ROLE_PRESETS, rolesForSector };
