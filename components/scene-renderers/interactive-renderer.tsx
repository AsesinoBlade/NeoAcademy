'use client';

import { useMemo } from 'react';
import type { InteractiveContent } from '@/lib/types/stage';

interface InteractiveRendererProps {
  readonly content: InteractiveContent;
  readonly mode: 'autonomous' | 'playback';
  readonly sceneId: string;
}

export function InteractiveRenderer({ content, mode: _mode, sceneId }: InteractiveRendererProps) {
  const patchedHtml = useMemo(
    () => (content.html ? patchHtmlForIframe(content.html) : undefined),
    [content.html],
  );

  return (
    <div className="w-full h-full relative">
      <iframe
        srcDoc={patchedHtml}
        src={patchedHtml ? undefined : content.url}
        className="absolute inset-0 w-full h-full border-0"
        title={`Interactive Scene ${sceneId}`}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
    </div>
  );
}

/**
 * Patch embedded HTML to display correctly inside an iframe.
 *
 * Fixes:
 * - min-h-screen / h-screen → use 100% of iframe viewport
 * - Ensure html/body fill the iframe with no overflow issues
 * - Canvas elements use container sizing instead of viewport
 */
function patchHtmlForIframe(html: string): string {
  // Generated interactive HTML occasionally contains a mismatched quote on
  // Tailwind arbitrary-color classes inside JavaScript strings, for example:
  //
  //   class='text-[#e8b25a]"
  //
  // The stray double quote terminates the surrounding JavaScript string and
  // prevents the generated script from parsing. Repair this narrowly before
  // supplying the HTML to the iframe.
  const repairedHtml = html.replace(
    /class='text-\[#([0-9a-fA-F]{3,8})\]"/g,
    "class='text-[#$1]'",
  );
  const iframeCss = `<style data-iframe-patch>
  html, body {
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    overflow-x: hidden;
    overflow-y: auto;
  }
  /* Fix min-h-screen: in iframes 100vh is the iframe height, which is correct,
     but ensure body actually fills it */
  body { min-height: 100vh; }
</style>`;

  // Generated interactive HTML is model-authored JavaScript. Be defensive about
  // a common CanvasGradient mistake where the model emits
  // addColorStop(color, offset) instead of addColorStop(offset, color).
  //
  // The native API throws on NaN/Infinity offsets, which otherwise aborts the
  // entire animation frame and can leave an interactive canvas completely blank.
  const canvasSafetyPatch = `<script data-canvas-safety-patch>
(function () {
  if (
    typeof CanvasGradient === 'undefined' ||
    !CanvasGradient.prototype ||
    typeof CanvasGradient.prototype.addColorStop !== 'function'
  ) {
    return;
  }

  const originalAddColorStop =
    CanvasGradient.prototype.addColorStop;

  CanvasGradient.prototype.addColorStop =
    function patchedAddColorStop(offset, color) {
      let safeOffset = offset;
      let safeColor = color;

      // Repair reversed arguments: addColorStop(color, offset).
      if (
        typeof safeOffset === 'string' &&
        typeof safeColor === 'number'
      ) {
        const swappedColor = safeOffset;
        safeOffset = safeColor;
        safeColor = swappedColor;
      }

      const numericOffset = Number(safeOffset);

      if (!Number.isFinite(numericOffset)) {
        console.warn(
          '[NeoAcademy] Ignoring invalid CanvasGradient color stop:',
          safeOffset,
          safeColor,
        );
        return;
      }

      const clampedOffset =
        Math.min(1, Math.max(0, numericOffset));

      try {
        return originalAddColorStop.call(
          this,
          clampedOffset,
          String(safeColor),
        );
      } catch (error) {
        console.warn(
          '[NeoAcademy] Ignoring invalid CanvasGradient color stop:',
          clampedOffset,
          safeColor,
          error,
        );
      }
    };
})();
</script>`;

  // Generated image-inspection interactives may keep inactive evidence cards
  // in the layout at opacity: 0. Invisible cards must not intercept hotspot
  // clicks. The one visible evidence card is also kept inside its clipping
  // visualization container.
  const evidenceCardSafetyPatch = `<script data-evidence-card-safety-patch>
(function () {
  const CARD_SELECTOR = '.evidence-card';
  const EDGE_PADDING = 8;

  function findClippingAncestor(element) {
    let current = element.parentElement;

    while (current && current !== document.body) {
      const style = getComputedStyle(current);

      if (
        style.overflow === 'hidden' ||
        style.overflow === 'clip' ||
        style.overflowX === 'hidden' ||
        style.overflowX === 'clip' ||
        style.overflowY === 'hidden' ||
        style.overflowY === 'clip'
      ) {
        return current;
      }

      current = current.parentElement;
    }

    return null;
  }

  function resetClamp(card) {
    if (card.dataset.neoEvidenceClamp !== '1') {
      return;
    }

    card.style.translate =
      card.dataset.neoEvidenceOriginalTranslate || '';

    delete card.dataset.neoEvidenceClamp;
  }

  function clampVisibleCard(card) {
    resetClamp(card);

    const clippingAncestor =
      findClippingAncestor(card);

    if (!clippingAncestor) {
      return;
    }

    const cardRect =
      card.getBoundingClientRect();

    const boundary =
      clippingAncestor.getBoundingClientRect();

    let dx = 0;
    let dy = 0;

    const safeLeft =
      boundary.left + EDGE_PADDING;

    const safeRight =
      boundary.right - EDGE_PADDING;

    const safeTop =
      boundary.top + EDGE_PADDING;

    const safeBottom =
      boundary.bottom - EDGE_PADDING;

    if (cardRect.left < safeLeft) {
      dx += safeLeft - cardRect.left;
    }

    if (cardRect.right + dx > safeRight) {
      dx -= cardRect.right + dx - safeRight;
    }

    if (cardRect.top < safeTop) {
      dy += safeTop - cardRect.top;
    }

    if (cardRect.bottom + dy > safeBottom) {
      dy -= cardRect.bottom + dy - safeBottom;
    }

    if (dx === 0 && dy === 0) {
      return;
    }

    if (!('neoEvidenceOriginalTranslate' in card.dataset)) {
      card.dataset.neoEvidenceOriginalTranslate =
        card.style.translate || '';
    }

    card.style.translate =
      dx + 'px ' + dy + 'px';

    card.dataset.neoEvidenceClamp = '1';
  }

  function syncEvidenceCards() {
    document
      .querySelectorAll(CARD_SELECTOR)
      .forEach((card) => {
        if (!(card instanceof HTMLElement)) {
          return;
        }

        const style =
          getComputedStyle(card);

        const opacity =
          Number.parseFloat(style.opacity || '1');

        const visible =
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number.isFinite(opacity) &&
          opacity > 0.01;

        if (!visible) {
          card.style.pointerEvents = 'none';
          resetClamp(card);
          return;
        }

        card.style.pointerEvents = 'auto';
        clampVisibleCard(card);
      });
  }

  let scheduled = false;

  function scheduleSync() {
    if (scheduled) {
      return;
    }

    scheduled = true;

    requestAnimationFrame(() => {
      scheduled = false;
      syncEvidenceCards();

      // Allow CSS transitions or generated click handlers to finish updating
      // card opacity/position before the final geometry check.
      setTimeout(
        syncEvidenceCards,
        50,
      );
    });
  }

  const observer =
    new MutationObserver(scheduleSync);

  function start() {
    syncEvidenceCards();

    observer.observe(
      document.body,
      {
        subtree: true,
        attributes: true,
        attributeFilter: [
          'class',
          'style',
          'hidden',
          'aria-hidden',
        ],
      },
    );

    document.addEventListener(
      'click',
      scheduleSync,
      true,
    );

    window.addEventListener(
      'resize',
      scheduleSync,
    );
  }

  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      start,
      { once: true },
    );
  } else {
    start();
  }
})();
</script>`;

  const iframePatch =
    iframeCss +
    '\n' +
    canvasSafetyPatch +
    '\n' +
    evidenceCardSafetyPatch;
  // Insert right after <head> or at the start of the document
  const headIdx = repairedHtml.indexOf('<head>');
  if (headIdx !== -1) {
    const insertPos = headIdx + 6; // after <head>
    return repairedHtml.substring(0, insertPos) + '\n' + iframePatch + repairedHtml.substring(insertPos);
  }

  const headWithAttrs = repairedHtml.indexOf('<head ');
  if (headWithAttrs !== -1) {
    const closeAngle = repairedHtml.indexOf('>', headWithAttrs);
    if (closeAngle !== -1) {
      const insertPos = closeAngle + 1;
      return repairedHtml.substring(0, insertPos) + '\n' + iframePatch + repairedHtml.substring(insertPos);
    }
  }

  // Fallback: prepend
  return iframePatch + repairedHtml;
}
