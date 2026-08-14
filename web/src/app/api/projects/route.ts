import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function GET(req: NextRequest) {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const projects = await prisma.project.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { clips: true } },
      jobs: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  return NextResponse.json(projects);
}

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const title = String(body.title || "").trim();
  const source = String(body.source || "").trim();
  const sourceType = body.sourceType === "upload" ? "upload" : "youtube";

  if (!source) {
    return NextResponse.json({ error: "source is required" }, { status: 400 });
  }

  const project = await prisma.project.create({
    data: {
      userId: session.user.id,
      title: title || "Untitled",
      source,
      sourceType,
    },
  });
  return NextResponse.json(project, { status: 201 });
}
