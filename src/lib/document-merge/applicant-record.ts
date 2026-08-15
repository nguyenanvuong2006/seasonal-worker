/**
 * Flatten daily_application + department + DW + worker_profile + customAnswers
 * into one record the merge resolver / preview can consume.
 */

export type ApplicantMergeSources = {
  application: {
    id: string;
    cccd: string;
    fullName: string;
    gender?: string | null;
    dob?: string | null;
    phone?: string | null;
    ethnicity?: string | null;
    permanentAddress?: string | null;
    residentialAddress?: string | null;
    declaredType?: string | null;
    dwMatch?: string | null;
    dwCode?: string | null;
    itCode?: string | null;
    workDuration?: string | null;
    referralChannel?: string | null;
    status?: string | null;
    regDate?: string | null;
    startingDate?: string | null;
    customAnswers?: Record<string, string> | null;
    noteWorker?: string | null;
  };
  department?: {
    deptName?: string | null;
    groupName?: string | null;
    vnName?: string | null;
    location?: string | null;
    division?: string | null;
    section?: string | null;
    supervisor?: string | null;
    supervisorPhone?: string | null;
  } | null;
  dw?: {
    code?: string | null;
    itCode?: string | null;
    fullName?: string | null;
    gender?: string | null;
    bod?: string | null;
    phone?: string | null;
    permanentAddress?: string | null;
    residentialAddress?: string | null;
    dateOfIssue?: string | null;
    placeOfIssue?: string | null;
  } | null;
  worker?: {
    fullName?: string | null;
    cccd?: string | null;
    gender?: string | null;
    dob?: string | null;
    phone?: string | null;
    permanentAddress?: string | null;
    residentialAddress?: string | null;
    fingerprintCode?: string | null;
  } | null;
};

export function buildApplicantMergeRecord(sources: ApplicantMergeSources): Record<string, unknown> {
  const { application, department, dw, worker } = sources;
  const customAnswers = application.customAnswers ?? {};

  return {
    id: application.id,
    cccd: application.cccd,
    fullName: application.fullName,
    gender: application.gender ?? dw?.gender ?? worker?.gender ?? null,
    dob: application.dob ?? dw?.bod ?? worker?.dob ?? null,
    phone: application.phone ?? dw?.phone ?? worker?.phone ?? null,
    ethnicity: application.ethnicity ?? null,
    permanentAddress: application.permanentAddress ?? dw?.permanentAddress ?? worker?.permanentAddress ?? null,
    residentialAddress: application.residentialAddress ?? dw?.residentialAddress ?? worker?.residentialAddress ?? null,
    declaredType: application.declaredType ?? "NEW",
    dwMatch: application.dwMatch ?? "NEW",
    dwCode: application.dwCode ?? dw?.code ?? null,
    itCode: application.itCode ?? dw?.itCode ?? null,
    workDuration: application.workDuration ?? null,
    referralChannel: application.referralChannel ?? null,
    status: application.status ?? null,
    regDate: application.regDate ?? null,
    startingDate: application.startingDate ?? null,
    deptName: department?.deptName ?? null,
    groupName: department?.groupName ?? null,
    vnName: department?.vnName ?? null,
    location: department?.location ?? null,
    division: department?.division ?? null,
    section: department?.section ?? null,
    supervisor: department?.supervisor ?? null,
    supervisorPhone: department?.supervisorPhone ?? null,
    customAnswers,
    department: department ?? {},
    dw: dw ?? {},
    worker: worker ?? {},
    daily_applications: application,
    worker_profiles: worker ?? {},
    departments: department ?? {},
    dw_data: dw ?? {},
  };
}
