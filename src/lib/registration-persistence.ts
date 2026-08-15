/**
 * Transaction orchestration for one public registration. This module is DB-agnostic
 * so rollback behavior can be proven with synthetic unit tests. The production
 * adapter is Drizzle's db.transaction() in POST /api/registrations.
 */
export type RegistrationPersistenceInput<ApplicationInput, ProfileInput> = {
  application: ApplicationInput;
  profile: ProfileInput;
};

export type RegistrationTransactionTx<ApplicationInput, Application, ProfileInput, Profile> = {
  createApplication(input: ApplicationInput): Promise<Application>;
  upsertProfile(input: ProfileInput): Promise<Profile>;
  createEmploymentSession(input: { application: Application; profile: Profile }): Promise<void>;
};

export type RegistrationTransactionRunner<ApplicationInput, Application, ProfileInput, Profile> = <T>(
  callback: (tx: RegistrationTransactionTx<ApplicationInput, Application, ProfileInput, Profile>) => Promise<T>,
) => Promise<T>;

export async function persistRegistrationAtomically<ApplicationInput, Application, ProfileInput, Profile>(
  runTransaction: RegistrationTransactionRunner<ApplicationInput, Application, ProfileInput, Profile>,
  input: RegistrationPersistenceInput<ApplicationInput, ProfileInput>,
): Promise<{ application: Application; profile: Profile }> {
  return runTransaction(async (tx) => {
    const application = await tx.createApplication(input.application);
    const profile = await tx.upsertProfile(input.profile);
    await tx.createEmploymentSession({ application, profile });
    return { application, profile };
  });
}
