import path from "node:path";
import { chromium } from "playwright";
import { pathToFileURL } from "node:url";

export async function writePdfReport(htmlPath: string): Promise<string> {
  const pdfPath = path.join(path.dirname(htmlPath), "report.pdf");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
    await page.pdf({ path: pdfPath, format: "A4", printBackground: true });
  } finally {
    await browser.close();
  }
  return pdfPath;
}
