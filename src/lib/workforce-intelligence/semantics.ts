/**
 * Stable analytics semantics. Workflow Engine currently configures display/stage
 * availability but has no semantic tags, so analytics mappings live in this one file.
 * Do not scatter these stage keys through forecasting queries.
 */
export const WORKFORCE_STATUS_SEMANTICS = {
  recordedWorkforce: {
    activeEmploymentSession: "APPROVED",
  },
  movement: {
    confirmedResignation: ["INACTIVE"],
    confirmedTransfer: ["TRANSFER_COMPLETED"],
    unconfirmed: ["PENDING_HR", "TRANSFER_RESCHEDULED", "WAITING_DECISION"],
  },
} as const;

export function isConfirmedResignationStatus(status: string): boolean {
  return (WORKFORCE_STATUS_SEMANTICS.movement.confirmedResignation as readonly string[]).includes(status);
}

export function isConfirmedTransferStatus(status: string): boolean {
  return (WORKFORCE_STATUS_SEMANTICS.movement.confirmedTransfer as readonly string[]).includes(status);
}

export type EmploymentSessionSnapshot = {
  workerId: string;
  status: string;
  regDate: string;
  startingDate: string | null;
  endDate: string | null;
  workerProfileAvailable: boolean;
  workerProfileDeleted: boolean;
};

export function isRecordedCurrentWorkforce(session: EmploymentSessionSnapshot, today: string): boolean {
  const start = session.startingDate ?? session.regDate;
  return session.workerProfileAvailable
    && !session.workerProfileDeleted
    && session.status === WORKFORCE_STATUS_SEMANTICS.recordedWorkforce.activeEmploymentSession
    && start <= today
    && (session.endDate === null || session.endDate > today);
}

export function isConfirmedIncoming(session: EmploymentSessionSnapshot, today: string, forecastTo: string): boolean {
  return session.workerProfileAvailable
    && !session.workerProfileDeleted
    && session.status === WORKFORCE_STATUS_SEMANTICS.recordedWorkforce.activeEmploymentSession
    && session.startingDate !== null
    && session.startingDate > today
    && session.startingDate <= forecastTo
    && (session.endDate === null || session.endDate >= session.startingDate);
}
