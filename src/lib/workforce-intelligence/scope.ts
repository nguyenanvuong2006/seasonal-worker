/** Pure scope helpers shared by the data/tool layer and unit tests. */
export function canAccessDepartment(scope: string[] | null, departmentId: string): boolean {
  return scope === null || scope.includes(departmentId);
}

export function restrictDepartmentIds(scope: string[] | null, requestedDepartmentId: string | null): string[] | null {
  if (requestedDepartmentId) return canAccessDepartment(scope, requestedDepartmentId) ? [requestedDepartmentId] : [];
  return scope === null ? null : [...scope];
}

/** AI tools fail closed: a model/user supplied department never widens session scope. */
export function resolveAuthorizedToolDepartment(scope: string[] | null, requestedDepartmentId: string): string | null {
  return canAccessDepartment(scope, requestedDepartmentId) ? requestedDepartmentId : null;
}
