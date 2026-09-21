import { NextResponse } from "next/server";
import { generatePeriods } from "@/lib/scheduler";
import { getCurrentUser } from "@/lib/auth";

// The cron entry point for period generation.
//
// Point any scheduler at this URL once a day:
//   curl -X POST https://<host>/api/cron/generate-periods \
//        -H "Authorization: Bearer $CRON_SECRET"
//
// Vercel Cron does exactly that from vercel.json and sends CRON_SECRET as a
// bearer token automatically. GET is accepted too, because most hosted cron
// services only issue GETs.
//
// Authorization, in order:
//   1. Bearer token / ?secret= matching CRON_SECRET.
//   2. A signed-in ADMIN session (this is what the "Run now" button uses).
// With no CRON_SECRET configured, only an admin session works — an unguarded
// public endpoint that writes rows is not an acceptable default, even though
// the job itself is idempotent.

export const dynamic = "force-dynamic";

async function authorize(request: Request): Promise<string | null> {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const header = request.headers.get("authorization");
    const url = new URL(request.url);
    const provided =
      header?.toLowerCase().startsWith("bearer ")
        ? header.slice(7).trim()
        : url.searchParams.get("secret");
    if (provided && timingSafeEqual(provided, secret)) return "cron";
  }

  const user = await getCurrentUser();
  if (user?.role === "ADMIN") return "manual";

  return null;
}

// Constant-time compare so a wrong secret can't be discovered byte by byte.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function run(request: Request) {
  const trigger = await authorize(request);
  if (!trigger) {
    return NextResponse.json(
      {
        error:
          "Unauthorized. Send Authorization: Bearer <CRON_SECRET>, or sign in as an admin.",
      },
      { status: 401 }
    );
  }

  const summary = await generatePeriods({
    trigger: trigger === "cron" ? "cron" : "manual",
  });

  return NextResponse.json(summary, { status: summary.status === "SUCCESS" ? 200 : 500 });
}

export async function GET(request: Request) {
  return run(request);
}

export async function POST(request: Request) {
  return run(request);
}
