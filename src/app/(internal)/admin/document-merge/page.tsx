import { redirect } from "next/navigation";
import { getSession, getSessionPermissionKeys } from "@/lib/auth";
import DocumentMergeClient from "./document-merge-client";

export default async function DocumentMergeCenterPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const permissions = await getSessionPermissionKeys(session);
  return <DocumentMergeClient permissions={permissions} role={session.role} />;
}
