import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { presignedGet } from "@/lib/s3";

export async function GET(
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
    include: {
      clips: { orderBy: { createdAt: "asc" } },
      jobs: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const clips = await Promise.all(
    project.clips.map(async (clip) => ({
      ...clip,
      signedVideoUrl: clip.videoUrl ? await presignedGet(clip.videoUrl) : null,
      signedThumbnailUrl: clip.thumbnailUrl
        ? await presignedGet(clip.thumbnailUrl)
        : null,
    }))
  );

  return NextResponse.json({ ...project, clips });
}
