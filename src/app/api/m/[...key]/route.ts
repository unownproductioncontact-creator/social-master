import { getObjectStream } from "@/lib/storage";

export async function GET(req: Request, ctx: RouteContext<"/api/m/[...key]">) {
  const { key } = await ctx.params;
  const storageKey = key.join("/");
  const range = req.headers.get("range") ?? undefined;

  try {
    const object = await getObjectStream(storageKey, range);
    if (!object.Body) {
      return new Response("Not found", { status: 404 });
    }

    const headers = new Headers();
    if (object.ContentType) headers.set("Content-Type", object.ContentType);
    if (object.ContentLength != null) headers.set("Content-Length", String(object.ContentLength));
    if (object.ContentRange) headers.set("Content-Range", object.ContentRange);
    headers.set("Accept-Ranges", "bytes");
    headers.set("Cache-Control", "public, max-age=31536000, immutable");

    const webStream = object.Body.transformToWebStream();
    return new Response(webStream, { status: object.ContentRange ? 206 : 200, headers });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
