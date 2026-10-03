import {
  NextRequest,
  NextResponse,
} from 'next/server';
import {
  localizeImagesWithLocalVision,
  type LocalVisionLocalizationInput,
} from '@/lib/server/local-vision';
import type {
  MediaAnnotationFeature,
} from '@/lib/media/types';

export const maxDuration = 300;

function normalizeFeatures(
  value: unknown,
): MediaAnnotationFeature[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const features:
    MediaAnnotationFeature[] = [];

  const seenIds =
    new Set<string>();

  for (const item of value) {
    if (
      !item ||
      typeof item !== 'object'
    ) {
      continue;
    }

    const record =
      item as Record<
        string,
        unknown
      >;

    const id =
      typeof record.id === 'string'
        ? record.id.trim()
        : '';

    const label =
      typeof record.label === 'string'
        ? record.label.trim()
        : '';

    const description =
      typeof record.description ===
      'string'
        ? record.description.trim()
        : undefined;

    if (
      !id ||
      !label ||
      seenIds.has(id)
    ) {
      continue;
    }

    seenIds.add(id);

    features.push({
      id,
      label,
      description,
    });
  }

  return features;
}

function normalizeInput(
  value: unknown,
  fallbackKey: string,
): LocalVisionLocalizationInput | null {
  if (
    !value ||
    typeof value !== 'object'
  ) {
    return null;
  }

  const record =
    value as Record<
      string,
      unknown
    >;

  const src =
    typeof record.src === 'string'
      ? record.src
      : '';

  const imageId =
    typeof record.imageId ===
    'string'
      ? record.imageId.trim()
      : fallbackKey;

  const key =
    typeof record.key === 'string'
      ? record.key.trim()
      : imageId;

  const sourceFileName =
    typeof record.sourceFileName ===
    'string'
      ? record.sourceFileName.trim()
      : imageId;

  const features =
    normalizeFeatures(
      record.features,
    );

  if (
    !src ||
    !key ||
    features.length === 0
  ) {
    return null;
  }

  return {
    key,
    sourceFileName:
      sourceFileName ||
      imageId,
    imageId:
      imageId || key,
    src,
    features,
  };
}

export async function POST(
  request: NextRequest,
) {
  try {
    const body =
      (await request.json()) as
        Record<string, unknown>;

    let inputs:
      LocalVisionLocalizationInput[] =
      [];

    if (
      Array.isArray(body.images)
    ) {
      inputs =
        body.images
          .map(
            (item, index) =>
              normalizeInput(
                item,
                `image_${index + 1}`,
              ),
          )
          .filter(
            (
              item,
            ): item is LocalVisionLocalizationInput =>
              item !== null,
          );
    }
    else {
      const single =
        normalizeInput(
          body,
          'image',
        );

      if (single) {
        inputs = [single];
      }
    }

    if (
      inputs.length === 0
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            'At least one valid localization image is required',
        },
        {
          status: 400,
        },
      );
    }

    const results =
      await localizeImagesWithLocalVision(
        inputs,
        request.signal,
      );

    return NextResponse.json({
      success: true,
      results:
        inputs.map(
          (input) => {
            const result =
              results.get(
                input.key,
              );

            return {
              key: input.key,
              regions:
                result?.regions ??
                [],
              model:
                result?.model,
            };
          },
        ),
    });
  }
  catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    return NextResponse.json(
      {
        success: false,
        error: message,
      },
      {
        status: 500,
      },
    );
  }
}