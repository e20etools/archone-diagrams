import type { ImageData } from "../ai/client";

/**
 * A PDF read in the browser with pdf.js, loaded only when a PDF is chosen: the text of its first
 * pages, and its first page as a picture, for the AI model to read a flowchart or a page that
 * describes a process. Scripts in the file are never run.
 */
export async function readPdf(file: File): Promise<{ text: string; pages: number; image: ImageData | null }> {
  const pdfjs = await import("pdfjs-dist");
  const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), enableXfa: false }).promise;
  try {
    const lines: string[] = [];
    for (let n = 1; n <= Math.min(doc.numPages, 20); n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      let line = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        line += item.str;
        if (item.hasEOL) {
          if (line.trim()) lines.push(line.trim());
          line = "";
        }
      }
      if (line.trim()) lines.push(line.trim());
      if (lines.join("\n").length > 12000) break;
    }
    // The first page as a picture, no more than 1800 pixels on its longer side.
    let image: ImageData | null = null;
    try {
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(3, 1800 / Math.max(base.width, base.height)) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      const png = canvas.toDataURL("image/png");
      const data = png.length < 6_800_000 ? png : canvas.toDataURL("image/jpeg", 0.85);
      image = { mime: data.startsWith("data:image/png") ? "image/png" : "image/jpeg", data: data.slice(data.indexOf(",") + 1) };
    } catch {
      image = null;
    }
    return { text: lines.join("\n").slice(0, 12000), pages: doc.numPages, image };
  } finally {
    void doc.destroy();
  }
}
