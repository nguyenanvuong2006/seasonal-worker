import { getPublicBranding } from "@/lib/branding";
import { LoginView } from "./login-view";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const branding = await getPublicBranding();
  return <LoginView branding={branding} />;
}
