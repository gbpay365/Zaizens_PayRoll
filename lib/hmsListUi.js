'use strict';

/** Staff role pill colors (Employees module). [label, color, background] */
const ROLE_BADGES = {
  '1': ['Admin', '#6b7280', '#f3f4f6'],
  '2': ['Doctor', '#ef4444', '#fef2f2'],
  '3': ['Front Desk', '#3b82f6', '#eff6ff'],
  '4': ['Lab Tech', '#8b5cf6', '#f5f3ff'],
  '5': ['Pharmacist', '#10b981', '#ecfdf5'],
  '6': ['Radiology', '#06b6d4', '#ecfeff'],
  '7': ['Nurse', '#f59e0b', '#fffbeb'],
  '8': ['Nursing Aid', '#14b8a6', '#f0fdfa'],
  '9': ['Accountant', '#1e3a8a', '#dbeafe'],
  '10': ['Cashier', '#0f766e', '#ccfbf1'],
  '11': ['Nurse Station', '#c026d3', '#fdf4ff'],
  '12': ['Nurse Aid', '#9333ea', '#faf5ff'],
  '99': ['Super Admin', '#1e293b', '#e2e8f0'],
};

function roleMeta(roleKey, fallbackLabel) {
  const rk = String(roleKey == null ? '' : roleKey);
  const rb = ROLE_BADGES[rk] || [
    fallbackLabel || 'Role ' + (rk || '—'),
    '#64748b',
    '#f1f5f9',
  ];
  return {
    label: fallbackLabel || rb[0],
    color: rb[1],
    bg: rb[2],
  };
}

function employeeStatus(status) {
  const on = Number(status) === 1;
  return { variant: on ? 'active' : 'inactive', label: on ? 'Active' : 'Inactive' };
}

function appointmentStatus(status) {
  const s = Number(status);
  if (s === 1) return { variant: 'confirmed', label: 'Confirmed' };
  if (s === 2) return { variant: 'completed', label: 'Completed' };
  if (s === 0) return { variant: 'cancelled', label: 'Cancelled' };
  return { variant: 'pending', label: 'Pending' };
}

function labStatus(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'received' || s === 'completed' || s === 'done') return { variant: 'active', label: s.toUpperCase() };
  if (s === 'in_progress' || s === 'processing') return { variant: 'info', label: s.replace(/_/g, ' ').toUpperCase() };
  if (s === 'cancelled') return { variant: 'cancelled', label: 'CANCELLED' };
  return { variant: 'pending', label: (s || 'pending').toUpperCase() };
}

function patientTypeBadge(patientType) {
  const t = String(patientType || '');
  const isIp = t === 'InPatient';
  return {
    variant: isIp ? 'danger' : 'success',
    label: t || '—',
  };
}

function prescriptionStatus(status) {
  const s = String(status || 'ORDERED').toUpperCase();
  if (/DISPENS|COMPLET|FILLED/.test(s)) return { variant: 'completed', label: s };
  if (/CANCEL/.test(s)) return { variant: 'cancelled', label: s };
  if (/PARTIAL/.test(s)) return { variant: 'info', label: s };
  return { variant: 'pending', label: s };
}

function queueStatusVariant(queueStatus) {
  const q = String(queueStatus || 'registered').toLowerCase();
  const map = {
    registered: 'info',
    triage: 'warning',
    waiting_doctor: 'warning',
    in_consultation: 'active',
    orders_pending: 'purple',
    billing: 'pink',
    completed: 'muted',
    cancelled: 'cancelled',
  };
  return map[q] || 'muted';
}

module.exports = {
  ROLE_BADGES,
  roleMeta,
  employeeStatus,
  appointmentStatus,
  labStatus,
  patientTypeBadge,
  prescriptionStatus,
  queueStatusVariant,
};
