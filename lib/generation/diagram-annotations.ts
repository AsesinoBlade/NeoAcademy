import type {
  LocalizedVisualRegion,
} from '@/lib/types/generation';
import type {
  MediaAnnotationRequest,
} from '@/lib/media/types';
import type {
  PPTElement,
  PPTImageElement,
  PPTLineElement,
  PPTTextElement,
} from '@/lib/types/slides';
import type {
  Scene,
} from '@/lib/types/stage';

const SLIDE_WIDTH = 1000;
const SLIDE_HEIGHT = 562.5;
const SAFE_MARGIN = 28;
const TITLE_SAFE_TOP = 95;
const LABEL_GAP = 14;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function annotationPrefix(
  elementId: string,
): string {
  return `diagram_annotation_${elementId}_`;
}

function safeIdPart(
  value: string,
): string {
  return value.replace(
    /[^a-zA-Z0-9_-]+/g,
    '_',
  );
}

function pickBestRegion(
  regions: LocalizedVisualRegion[],
  featureId: string,
): LocalizedVisualRegion | undefined {
  return regions
    .filter(
      (region) =>
        region.featureId === featureId,
    )
    .sort(
      (a, b) =>
        (b.confidence ?? 0) -
        (a.confidence ?? 0),
    )[0];
}

function findGeneratedImage(
  elements: PPTElement[],
  elementId: string,
): PPTImageElement | undefined {
  return elements.find(
    (element): element is PPTImageElement =>
      element.type === 'image' &&
      element.src === elementId,
  );
}

export function applyDiagramAnnotationsToScene(
  scene: Scene,
  elementId: string,
  request: MediaAnnotationRequest,
  regions: LocalizedVisualRegion[],
): Scene | null {
  if (
    scene.type !== 'slide' ||
    scene.content.type !== 'slide'
  ) {
    return null;
  }

  const originalElements =
    scene.content.canvas.elements;

  const image =
    findGeneratedImage(
      originalElements,
      elementId,
    );

  if (!image) {
    return null;
  }

  const prefix =
    annotationPrefix(elementId);

  const withoutExistingAnnotations =
    originalElements.filter(
      (element) =>
        !element.id.startsWith(prefix),
    );

  const resolved =
    request.features
      .map((feature) => ({
        feature,
        region:
          pickBestRegion(
            regions,
            feature.id,
          ),
      }))
      .filter(
        (
          item,
        ): item is typeof item & {
          region: LocalizedVisualRegion;
        } => Boolean(item.region),
      );

  if (resolved.length === 0) {
    return null;
  }

  const imageRight =
    image.left + image.width;

  const rightSpace =
    SLIDE_WIDTH -
    SAFE_MARGIN -
    imageRight -
    LABEL_GAP;

  const leftSpace =
    image.left -
    SAFE_MARGIN -
    LABEL_GAP;

  const side: 'left' | 'right' =
    rightSpace >= leftSpace
      ? 'right'
      : 'left';

  const availableSideWidth =
    side === 'right'
      ? rightSpace
      : leftSpace;

  const labelWidth =
    Math.max(
      145,
      Math.min(
        230,
        availableSideWidth,
      ),
    );

  const panelLeft =
    side === 'right'
      ? Math.min(
          SLIDE_WIDTH -
            SAFE_MARGIN -
            labelWidth,
          imageRight +
            LABEL_GAP,
        )
      : Math.max(
          SAFE_MARGIN,
          image.left -
            LABEL_GAP -
            labelWidth,
        );

  const panelRight =
    panelLeft + labelWidth;

  const featureNeedles =
    request.features
      .flatMap((feature) => [
        feature.label,
        feature.description ?? '',
      ])
      .map((value) =>
        value
          .replace(/<[^>]*>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean);

  const baseElements =
    withoutExistingAnnotations.filter(
      (element) => {
        if (
          element.type === 'image' &&
          element.id === image.id
        ) {
          return true;
        }

        const elementWidth =
          typeof element.width === 'number'
            ? element.width
            : 0;

        const elementRight =
          element.left + elementWidth;

        const overlapsAnnotationColumn =
          element.top > TITLE_SAFE_TOP - 18 &&
          element.left < panelRight + 18 &&
          elementRight > panelLeft - 18;

        const content =
          typeof (element as { content?: unknown }).content === 'string'
            ? String((element as { content?: unknown }).content)
                .replace(/<[^>]*>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase()
            : '';

        const mentionsRequestedFeature =
          content.length > 0 &&
          featureNeedles.some(
            (needle) =>
              needle.length > 2 &&
              content.includes(needle),
          );

        return !(
          element.type !== 'image' &&
          (
            overlapsAnnotationColumn ||
            mentionsRequestedFeature
          )
        );
      },
    );

  const preferredTop =
    Math.max(
      TITLE_SAFE_TOP,
      Math.min(
        image.top,
        SLIDE_HEIGHT - 120,
      ),
    );

  const availableHeight =
    Math.max(
      100,
      SLIDE_HEIGHT -
        SAFE_MARGIN -
        preferredTop,
    );

  const slotHeight =
    Math.min(
      82,
      availableHeight /
        resolved.length,
    );

  const labelHeight =
    Math.max(
      46,
      Math.min(
        72,
        slotHeight - 6,
      ),
    );

  const annotationElements: PPTElement[] =
    [];

  resolved.forEach(
    (
      { feature, region },
      index,
    ) => {
      const safeFeatureId =
        safeIdPart(
          feature.id,
        );

      const centerX =
        region.x +
        region.width / 2;

      const centerY =
        region.y +
        region.height / 2;

      // Prefer the vision model's explicit callout anchor when available.
      // Older localization results remain compatible by falling back to
      // the geometric center of the localized bounding box.
      const anchorX =
        region.anchorX ??
        centerX;

      const anchorY =
        region.anchorY ??
        centerY;

      const targetX =
        image.left +
        anchorX * image.width;

      const targetY =
        image.top +
        anchorY * image.height;

      const labelTop =
        Math.min(
          SLIDE_HEIGHT -
            SAFE_MARGIN -
            labelHeight,
          preferredTop +
            index * slotHeight,
        );

      const labelCenterY =
        labelTop +
        labelHeight / 2;

      const lineEndX =
        side === 'right'
          ? panelLeft
          : panelLeft +
            labelWidth;

      const lineId =
        `${prefix}${safeFeatureId}_line`;

      const textId =
        `${prefix}${safeFeatureId}_text`;

      // PPTLineElement uses:
      // - left/top as the absolute origin of the line's local coordinate space
      // - start/end as coordinates RELATIVE to that origin
      // - width as STROKE THICKNESS, not the horizontal span
      const lineLeft =
        Math.min(
          targetX,
          lineEndX,
        );

      const lineTop =
        Math.min(
          targetY,
          labelCenterY,
        );

      const line: PPTLineElement = {
        id: lineId,
        type: 'line',
        left: lineLeft,
        top: lineTop,
        width: 2,
        start: [
          targetX -
            lineLeft,
          targetY -
            lineTop,
        ],
        end: [
          lineEndX -
            lineLeft,
          labelCenterY -
            lineTop,
        ],
        style: 'solid',
        color: '#475569',
        points: [
          'dot',
          '',
        ],
      };

      const descriptionHtml =
        feature.description
          ? `<p style="margin:3px 0 0 0;font-size:12px;line-height:1.25;color:#475569;">${escapeHtml(feature.description)}</p>`
          : '';

      const text: PPTTextElement = {
        id: textId,
        type: 'text',
        left: panelLeft,
        top: labelTop,
        width: labelWidth,
        height: labelHeight,
        rotate: 0,
        content:
          `<p style="margin:0;font-size:16px;line-height:1.15;"><strong>${escapeHtml(feature.label)}</strong></p>` +
          descriptionHtml,
        defaultFontName:
          'Microsoft YaHei',
        defaultColor:
          '#0f172a',
        fill:
          '#ffffff',
        outline: {
          style: 'solid',
          width: 1,
          color: '#cbd5e1',
        },
        lineHeight: 1.2,
        paragraphSpace: 2,
      };

      annotationElements.push(
        line,
        text,
      );
    },
  );

  return {
    ...scene,
    content: {
      ...scene.content,
      canvas: {
        ...scene.content.canvas,
        elements: [
          ...baseElements,
          ...annotationElements,
        ],
      },
    },
    updatedAt:
      Date.now(),
  };
}