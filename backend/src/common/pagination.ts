export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

export interface PaginationQuery {
  page?: number;
  limit?: number;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}

/**
 * Resolve a raw page/limit pair into validated values.
 *
 * `page` is clamped to a minimum of 1 so callers can never accidentally turn
 * `Array.prototype.slice`'s negative-start behaviour into reading from the end
 * of the list. `limit` is clamped to `[1, MAX_PAGE_LIMIT]`.
 */
export function normalizePagination(query: PaginationQuery = {}): Required<PaginationQuery> {
  return {
    page: positiveInteger(query.page, 1),
    limit: Math.min(positiveInteger(query.limit, DEFAULT_PAGE_LIMIT), MAX_PAGE_LIMIT),
  };
}

export function paginate<T>(items: T[], query: PaginationQuery = {}): PaginatedResponse<T> {
  const { page, limit } = normalizePagination(query);
  const start = (page - 1) * limit;
  return {
    items: items.slice(start, start + limit),
    total: items.length,
    page,
    limit,
  };
}
