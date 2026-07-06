import { NextResponse } from "next/server";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";
import { cookies } from "next/headers";
import { z } from "zod";
import { registerUser, AuthError } from "@/lib/auth/userAuth";
import { isMultiUserModeEnabled } from "@/lib/db/users";
import { getSettings } from "@/lib/localDb";
import { logAuditEvent, getAuditRequestContext } from "@/lib/compliance/index";

const RegisterSchema = z.object({
  email: z.string().email().max(256),
  password: z.string().min(8).max(256),
  displayName: z.string().max(128).optional(),
});

export const authRouteInternals = { getCookieStore: cookies };

export async function POST(request: Request) {
  const auditContext = getAuditRequestContext(request);
  const settings = await getSettings();
  if (!isMultiUserModeEnabled(settings as never)) {
    return NextResponse.json({ error: "Registration is disabled. Multi-user mode is not enabled." }, { status: 403 });
  }
  let rawBody: unknown;
  try { rawBody = await request.json(); } catch {
    return NextResponse.json({ error: { message: "Invalid JSON" } }, { status: 400 });
  }
  const parsed = RegisterSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: { message: "Invalid registration data", details: parsed.error.issues } }, { status: 400 });
  }
  try {
    const { user, token } = await registerUser({
      email: parsed.data.email, password: parsed.data.password, displayName: parsed.data.displayName,
    });
    const forceSecureCookie = process.env.AUTH_COOKIE_SECURE === "true";
    const forwardedProtoHeader = request.headers.get("x-forwarded-proto") || "";
    const forwardedProto = forwardedProtoHeader.split(",")[0].trim().toLowerCase();
    const isHttpsRequest = forwardedProto === "https" || request.url?.startsWith("https:");
    const useSecureCookie = forceSecureCookie || isHttpsRequest;
    const cookieStore = await authRouteInternals.getCookieStore();
    cookieStore.set("auth_token", token, {
      httpOnly: true, secure: useSecureCookie, sameSite: "lax", path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    logAuditEvent({
      action: "auth.register.success", actor: user.id, target: user.id,
      resourceType: "user_account", status: "success",
      ipAddress: auditContext.ipAddress || undefined, requestId: auditContext.requestId,
      metadata: { email: user.email, role: user.role },
    });
    return NextResponse.json({
      success: true,
      user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      logAuditEvent({
        action: "auth.register.failed", actor: "anonymous", target: "user_account",
        resourceType: "user_account", status: "failed",
        ipAddress: auditContext.ipAddress || undefined, requestId: auditContext.requestId,
        metadata: { code: error.code, email: parsed.data.email },
      });
      return NextResponse.json({ error: sanitizeErrorMessage(error.message) }, { status: error.httpStatus });
    }
    console.error("[AUTH] Register failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
