'use strict';

/** Global list page size — React lists and server-rendered tables. */
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/**
 * @param {import('express').Request} req
 * @param {{ pageParam?: string, pageSize?: number }} [opts]
 */
function parsePage(req, opts = {}) {
  const pageParam = opts.pageParam || 'p';
  const raw = req && req.query ? req.query[pageParam] : null;
  const page = Math.max(1, parseInt(String(raw || ''), 10) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, parseInt(String(opts.pageSize || DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE)
  );
  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    pageParam,
  };
}

/**
 * @param {number} total
 * @param {number} page
 * @param {number} [pageSize]
 */
function metaFromTotal(total, page, pageSize = DEFAULT_PAGE_SIZE) {
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, pageSize || DEFAULT_PAGE_SIZE));
  const safeTotal = Math.max(0, parseInt(String(total), 10) || 0);
  const totalPages = Math.max(1, Math.ceil(safeTotal / size) || 1);
  const safePage = Math.min(Math.max(1, page), totalPages);
  const offset = (safePage - 1) * size;
  return {
    page: safePage,
    pageSize: size,
    total: safeTotal,
    totalPages,
    offset,
    hasPrev: safePage > 1,
    hasNext: safePage < totalPages,
    from: safeTotal === 0 ? 0 : offset + 1,
    to: Math.min(offset + size, safeTotal),
  };
}

/**
 * Build query string preserving filters; omits page param when page is 1 (optional).
 * @param {string} basePath e.g. '/opd-queue'
 * @param {number} page
 * @param {Record<string, string|number|null|undefined>} query
 * @param {{ pageParam?: string }} [opts]
 */
function buildPageUrl(basePath, page, query = {}, opts = {}) {
  const pageParam = opts.pageParam || 'p';
  const path = String(basePath || '/').split('?')[0] || '/';
  const q = Object.assign({}, query);
  if (page > 1) q[pageParam] = String(page);
  else delete q[pageParam];
  const parts = [];
  for (const [k, v] of Object.entries(q)) {
    if (v == null || v === '') continue;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
  }
  return parts.length ? path + '?' + parts.join('&') : path;
}

/**
 * @param {object} pool mysql2 pool
 * @param {{ req: object, countSql: string, countParams?: any[], dataSql: string, dataParams?: any[], pageParam?: string }} spec
 */
async function fetchPage(pool, spec) {
  const { page, pageSize, offset, pageParam } = parsePage(spec.req, { pageParam: spec.pageParam });
  const countParams = spec.countParams || [];
  const dataParams = spec.dataParams || [];

  const [[countRow]] = await pool.query(spec.countSql, countParams).catch(() => [[{ total: 0 }]]);
  const total =
    parseInt(String(countRow?.total ?? countRow?.c ?? countRow?.total_count ?? 0), 10) || 0;
  const meta = metaFromTotal(total, page, pageSize);

  const dataSql = String(spec.dataSql || '').trim();
  const hasLimit = /\bLIMIT\s+\?/i.test(dataSql);
  const sql = hasLimit ? dataSql : dataSql + ' LIMIT ? OFFSET ?';
  const params = hasLimit ? dataParams : [...dataParams, meta.pageSize, meta.offset];
  const [rows] = await pool.query(sql, params).catch(() => [[]]);

  return {
    rows: Array.isArray(rows) ? rows : [],
    pager: Object.assign(meta, {
      pageParam,
      basePath: spec.basePath || '',
      query: spec.query || {},
    }),
  };
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  parsePage,
  metaFromTotal,
  buildPageUrl,
  fetchPage,
};
