'use strict';

const { t } = require('./hmsI18n');

/** Maps ACL hub element codes → legacy.json keys under `hub.*`. */
const HUB_CODE_TO_LEGACY_KEY = {
  'hub.stat.opd_open': 'hub.stat_opd_open',
  'hub.stat.in_consult': 'hub.stat_in_consult',
  'hub.stat.appointments_today': 'hub.stat_appointments',
  'hub.stat.ipd_active': 'hub.stat_ipd_active',
  'hub.stat.lab_open': 'hub.stat_lab_open',
  'hub.stat.rad_open': 'hub.stat_rad_open',
  'hub.stat.pending_orders': 'hub.stat_pending_orders',
  'hub.stat.revenue_today': 'hub.stat_revenue_today',
  'hub.stat.patients_total': 'hub.stat_patients',
  'hub.stat.doctors_active': 'hub.stat_doctors',
  'hub.card.patients': 'hub.card_patients',
  'hub.card.appointments': 'hub.card_appointments',
  'hub.card.opd_queue': 'hub.card_opd_queue',
  'hub.card.hospitalization': 'hub.card_hospitalization',
  'hub.card.laboratory': 'hub.card_laboratory',
  'hub.card.radiology': 'hub.card_radiology',
  'hub.card.pharmacy': 'hub.card_pharmacy',
  'hub.card.cashier': 'hub.card_cashier',
  'hub.card.waiting_screen': 'hub.card_waiting_screen',
  'hub.card.appointment_slots': 'hub.card_appointment_slots',
  'hub.card.reports': 'hub.card_reports',
  'hub.panel.opd_today': 'hub.today_opd',
};

function hubLegacyKey(code) {
  return HUB_CODE_TO_LEGACY_KEY[String(code || '')] || null;
}

function hubLabel(code, defaultLabel, lang) {
  const key = hubLegacyKey(code);
  if (!key) return defaultLabel || code || '';
  return t(key, lang, { ns: 'legacy', defaultValue: defaultLabel || code });
}

module.exports = {
  HUB_CODE_TO_LEGACY_KEY,
  hubLegacyKey,
  hubLabel,
};
