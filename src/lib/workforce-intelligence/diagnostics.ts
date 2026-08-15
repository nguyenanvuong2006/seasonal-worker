export type AnalyticsCompleteness = {
  applications: number;
  applicationsWithoutSession: number;
  sessionsWithoutWorker: number;
  sessionsWithDeletedWorker: number;
  sessionsWithoutApplication: number;
  workersWithoutSession: number | null;
  missingApplicationDepartment: number | null;
  missingSessionDepartment: number | null;
  duplicateActiveWorkerProfiles: number;
  completenessRate: number | null;
  warnings: string[];
};

export function buildAnalyticsCompleteness(input: Omit<AnalyticsCompleteness, "completenessRate" | "warnings">): AnalyticsCompleteness {
  const applications = Math.max(0, input.applications);
  const linkedApplications = Math.max(0, applications - Math.max(0, input.applicationsWithoutSession));
  const completenessRate = applications > 0 ? Math.round((linkedApplications / applications) * 1000) / 10 : null;
  const warnings: string[] = [];
  if (input.applicationsWithoutSession > 0) warnings.push(`${input.applicationsWithoutSession} application chưa có Employment Session.`);
  if (input.sessionsWithoutWorker > 0) warnings.push(`${input.sessionsWithoutWorker} Employment Session không có Worker Profile hợp lệ.`);
  if (input.sessionsWithDeletedWorker > 0) warnings.push(`${input.sessionsWithDeletedWorker} Employment Session đang liên kết Worker Profile đã xoá.`);
  if (input.sessionsWithoutApplication > 0) warnings.push(`${input.sessionsWithoutApplication} Employment Session không có Daily Application hợp lệ.`);
  if ((input.workersWithoutSession ?? 0) > 0) warnings.push(`${input.workersWithoutSession} Worker Profile chưa có Employment Session.`);
  if ((input.missingApplicationDepartment ?? 0) > 0) warnings.push(`${input.missingApplicationDepartment} application chưa có department.`);
  if ((input.missingSessionDepartment ?? 0) > 0) warnings.push(`${input.missingSessionDepartment} Employment Session chưa có department.`);
  if (input.duplicateActiveWorkerProfiles > 0) warnings.push(`${input.duplicateActiveWorkerProfiles} CCCD có nhiều Worker Profile active.`);
  return { ...input, applications, completenessRate, warnings };
}

export function completenessConfirmedRatio(diagnostics: AnalyticsCompleteness): number {
  let ratio = diagnostics.completenessRate === null ? 1 : diagnostics.completenessRate / 100;
  const orphanSessions = diagnostics.sessionsWithoutWorker + diagnostics.sessionsWithDeletedWorker;
  if (orphanSessions > 0) ratio -= Math.min(0.3, orphanSessions * 0.02);
  if (diagnostics.duplicateActiveWorkerProfiles > 0) ratio -= 0.2;
  return Math.max(0, Math.min(1, ratio));
}
