import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { listProposals } from "@/lib/db";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const proposals = await listProposals();
  return NextResponse.json({ proposals, total: proposals.length });
}
