import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const project = await prisma.project.findFirst({
    where: { id, userId: session.user.id },
  });
  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const active = await prisma.job.findFirst({
    where: {
      projectId: id,
      status: { in: ["queued", "running"] },
    },
  });
  if (active) {
    return NextResponse.json(
      { error: "A job is already running for this project" },
      { status: 409 }
    );
  }

  const body = await req.json();
  const options = {
    orientation: body.orientation === "landscape" ? "landscape"
      : body.orientation === "original" ? "original" : "portrait",
    maxClips: Math.min(Math.max(parseInt(body.maxClips, 10) || 10, 1), 20),
  };

  const job = await prisma.job.create({
    data: { projectId: id, options },
  });
  await prisma.project.update({ where: { id }, data: { status: "queued" } });

  const backendUrl = process.env.BACKEND_URL;
  const internalKey = process.env.INTERNAL_API_KEY;
  if (backendUrl && internalKey) {
    try {
      const res = await fetch(`${backendUrl}/jobs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-api-key": internalKey,
        },
        body: JSON.stringify({ jobId: job.id }),
      });
      if (!res.ok) {
        await prisma.job.update({
          where: { id: job.id },
          data: { status: "failed", error: `Backend rejected job: ${res.status}` },
        });
      }
    } catch (err) {
      await prisma.job.update({
        where: { id: job.id },
        data: { status: "failed", error: String(err) },
      });
    }
  }

  return NextResponse.json(job, { status: 201 });
}
