import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { presignedPut } from "@/lib/s3";

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const fileName = String(body.fileName || "file").trim();
  const contentType = String(body.contentType || "application/octet-stream").trim();

  const extMatch = fileName.match(/\.([A-Za-z0-9]+)$/);
  const ext = extMatch ? extMatch[1].toLowerCase() : "bin";
  const key = `uploads/${crypto.randomUUID()}.${ext}`;

  const url = await presignedPut(key, contentType);
  return NextResponse.json({ url, key });
}
