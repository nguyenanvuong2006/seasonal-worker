/**
 * Pure, role-independent Data Scope policy.
 * null = unrestricted; [] = no department; [ids] = exactly those departments.
 */
export type DepartmentScope = string[] | null;
export type MovementScopeVisibility = "FULL" | "REDACTED_INCOMING" | "NONE";

export function scopeAllowsDepartment(scope: DepartmentScope, departmentId: string | null | undefined): boolean {
  if (scope === null) return true;
  return Boolean(departmentId && scope.includes(departmentId));
}

export function scopeAllowsAllDepartments(scope: DepartmentScope, departmentIds: (string | null | undefined)[]): boolean {
  return scope === null || departmentIds.every((id) => scopeAllowsDepartment(scope, id));
}

export function movementScopeVisibility(
  scope: DepartmentScope,
  movementType: string,
  fromDepartmentId: string | null,
  toDepartmentId: string | null,
): MovementScopeVisibility {
  if (scope === null) return "FULL";
  if (scope.length === 0) return "NONE";
  if (scopeAllowsDepartment(scope, fromDepartmentId)) return "FULL";
  if (movementType === "transfer" && scopeAllowsDepartment(scope, toDepartmentId)) return "REDACTED_INCOMING";
  return "NONE";
}

export function canAggregateTransferOut(scope: DepartmentScope, fromDepartmentId: string | null): boolean {
  return scopeAllowsDepartment(scope, fromDepartmentId);
}

export function canAggregateTransferIn(scope: DepartmentScope, toDepartmentId: string | null): boolean {
  return scopeAllowsDepartment(scope, toDepartmentId);
}
