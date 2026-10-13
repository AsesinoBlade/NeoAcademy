/**
 * Print the assembled book HTML to PDF with a locally installed Chromium
 * browser (Microsoft Edge ships with Windows 11; Chrome also works).
 * Override the browser with BOOK_PDF_BROWSER_PATH.
 */
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function browserCandidates(): string[] {
  const env = process.env.BOOK_PDF_BROWSER_PATH;
  const local = process.env.LOCALAPPDATA || '';
  const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
  const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';

  const list = [env || ''];
  if (os.platform() === 'win32') {
    list.push(
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    );
  } else if (os.platform() === 'darwin') {
    list.push(
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    );
  } else {
    list.push(
      '/usr/bin/microsoft-edge',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    );
  }
  return list.filter(Boolean);
}

export function findPdfBrowser(): string | null {
  return browserCandidates().find((candidate) => existsSync(candidate)) ?? null;
}

export async function printHtmlToPdf(options: {
  htmlPath: string;
  pdfPath: string;
  title: string;
  /** Extra Chromium args (tests use a sandbox-free headless build). */
  args?: string[];
  executablePath?: string;
}): Promise<{ bytes: number; browser: string }> {
  const executablePath = options.executablePath ?? findPdfBrowser();
  if (!executablePath) {
    throw new Error(
      'No Chromium browser found for PDF rendering. Install Microsoft Edge or Google Chrome, ' +
        'or set BOOK_PDF_BROWSER_PATH to its executable.',
    );
  }

  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      '--allow-file-access-from-files',
      // Chromium refuses to run as root without this (Linux containers only).
      ...(typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : []),
      ...(options.args ?? []),
    ],
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(0);
    await page.goto(pathToFileURL(options.htmlPath).href, { waitUntil: 'load', timeout: 0 });
    await page.waitForFunction('window.__bookReady === true', { timeout: 10 * 60 * 1000, polling: 500 });

    const shortTitle = options.title.length > 90 ? `${options.title.slice(0, 87).trimEnd()}...` : options.title;
    const escapedTitle = shortTitle.replace(/[<>&"]/g, '');
    const pdf = await page.pdf({
      path: options.pdfPath,
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: `<div style="width:100%;font-size:7.5px;color:#9ca3af;font-family:Segoe UI,Arial,sans-serif;padding:0 18mm;text-align:right;">${escapedTitle}</div>`,
      footerTemplate:
        '<div style="width:100%;font-size:8px;color:#6b7280;font-family:Segoe UI,Arial,sans-serif;text-align:center;"><span class="pageNumber"></span></div>',
      margin: { top: '20mm', bottom: '18mm', left: '20mm', right: '20mm' },
      outline: true,
      tagged: true,
      timeout: 0,
    });

    const stat = await fs.stat(options.pdfPath).catch(() => null);
    return { bytes: stat?.size ?? pdf.length, browser: path.basename(executablePath) };
  } finally {
    await browser.close();
  }
}
