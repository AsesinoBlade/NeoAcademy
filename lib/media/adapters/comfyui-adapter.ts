import type {
  ImageGenerationConfig,
  ImageGenerationOptions,
  ImageGenerationResult,
} from '../types';

import textToImageWorkflowTemplate from '../../../config/comfyui/neoAcademy_Flux_text_to_image.json';
import imageEditWorkflowTemplate from '../../../config/comfyui/NeoAcademy_Flux_Image_Edit.json';

export interface ComfyUiImageAsset {
  filename: string;
  subfolder: string;
  type: string;
}

export interface ComfyUiImageGenerationResult extends ImageGenerationResult {
  comfyUiAsset: ComfyUiImageAsset;
}

type WorkflowNode = {
  inputs: Record<string, unknown>;
  class_type: string;
  _meta?: {
    title?: string;
  };
};

type ComfyWorkflow = Record<string, WorkflowNode>;

type FluxImageMode =
  | 'text-to-image'
  | 'single-image-edit'
  | 'two-image-edit';

interface UploadedComfyImage {
  name: string;
  subfolder?: string;
  type?: string;
}

function cloneWorkflow(template: unknown): ComfyWorkflow {
  return JSON.parse(JSON.stringify(template)) as ComfyWorkflow;
}

function findNodeByTitle(
  workflow: ComfyWorkflow,
  title: string,
): WorkflowNode {
  const node = Object.values(workflow).find(
    (candidate) => candidate._meta?.title === title,
  );

  if (!node) {
    throw new Error(`ComfyUI workflow node not found: ${title}`);
  }

  return node;
}

function findNodesByTitle(
  workflow: ComfyWorkflow,
  title: string,
): WorkflowNode[] {
  const nodes = Object.values(workflow).filter(
    (candidate) => candidate._meta?.title === title,
  );

  if (nodes.length === 0) {
    throw new Error(`ComfyUI workflow node not found: ${title}`);
  }

  return nodes;
}

function getNode(
  workflow: ComfyWorkflow,
  id: string,
): WorkflowNode {
  const node = workflow[id];

  if (!node) {
    throw new Error(`ComfyUI workflow node not found: ${id}`);
  }

  return node;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function resolveBaseUrl(
  config: ImageGenerationConfig,
): string {
  return (
    config.baseUrl ||
    process.env.IMAGE_COMFYUI_BASE_URL ||
    'http://127.0.0.1:3100'
  );
}

function configureFluxModels(
  workflow: ComfyWorkflow,
): void {
  const diffusionModel = requireEnv(
    'IMAGE_FLUX_DIFFUSION_MODEL',
  );

  const textEncoder = requireEnv(
    'IMAGE_FLUX_TEXT_ENCODER',
  );

  const vae = requireEnv(
    'IMAGE_FLUX_VAE',
  );

  for (
    const node of findNodesByTitle(
      workflow,
      'Load Diffusion Model',
    )
  ) {
    node.inputs.unet_name = diffusionModel;
  }

  for (
    const node of findNodesByTitle(
      workflow,
      'Load CLIP',
    )
  ) {
    node.inputs.clip_name = textEncoder;
  }

  for (
    const node of findNodesByTitle(
      workflow,
      'Load VAE',
    )
  ) {
    node.inputs.vae_name = vae;
  }
}

function getRandomSeed(): number {
  return Math.floor(
    Math.random() * Number.MAX_SAFE_INTEGER,
  );
}

function getUploadFilename(
  prefix: string,
  extension: string,
): string {
  const randomPart = Math.random()
    .toString(36)
    .slice(2, 12);

  return `${prefix}-${Date.now()}-${randomPart}.${extension}`;
}

function resolveMode(
  options: ImageGenerationOptions,
): FluxImageMode {
  const hasFirstImage =
    Boolean(options.inputImageBase64);

  const hasSecondImage =
    Boolean(options.secondImageBase64);

  const hasSecondPrompt =
    Boolean(options.secondPrompt?.trim());

  if (
    !hasFirstImage &&
    !hasSecondImage &&
    !hasSecondPrompt
  ) {
    return 'text-to-image';
  }

  if (!hasFirstImage) {
    throw new Error(
      'A first input image is required before a second image or second prompt can be used.',
    );
  }

  if (
    !hasSecondImage &&
    !hasSecondPrompt
  ) {
    return 'single-image-edit';
  }

  if (
    !hasSecondImage ||
    !hasSecondPrompt
  ) {
    throw new Error(
      'Two-image editing requires both secondImageBase64 and secondPrompt.',
    );
  }

  return 'two-image-edit';
}

function normalizeImageDataUrl(
  value: string,
): {
  dataUrl: string;
  extension: string;
} {
  const trimmed = value.trim();

  const match =
    /^data:(image\/[A-Za-z0-9.+-]+);base64,/i.exec(
      trimmed,
    );

  if (match) {
    const mimeType = match[1].toLowerCase();

    const extension =
      mimeType === 'image/jpeg'
        ? 'jpg'
        : mimeType === 'image/webp'
          ? 'webp'
          : mimeType === 'image/gif'
            ? 'gif'
            : 'png';

    return {
      dataUrl: trimmed,
      extension,
    };
  }

  return {
    dataUrl: `data:image/png;base64,${trimmed}`,
    extension: 'png',
  };
}

async function uploadImageToComfyUi(
  baseUrl: string,
  imageBase64: string,
  prefix: string,
): Promise<UploadedComfyImage> {
  const normalized =
    normalizeImageDataUrl(imageBase64);

  /*
   * Using fetch(data:) gives us a standards-compliant Blob and
   * avoids Node Buffer / DOM BlobPart TypeScript incompatibilities.
   */
  const sourceResponse = await fetch(
    normalized.dataUrl,
  );

  if (!sourceResponse.ok) {
    throw new Error(
      'Could not decode input image.',
    );
  }

  const blob = await sourceResponse.blob();

  if (blob.size === 0) {
    throw new Error(
      'Input image decoded to zero bytes.',
    );
  }

  const filename = getUploadFilename(
    prefix,
    normalized.extension,
  );

  const form = new FormData();

  form.append(
    'image',
    blob,
    filename,
  );

  form.append('type', 'input');
  form.append('overwrite', 'true');

  const response = await fetch(
    `${baseUrl}/upload/image`,
    {
      method: 'POST',
      body: form,
    },
  );

  if (!response.ok) {
    throw new Error(
      `ComfyUI image upload failed: HTTP ${response.status} ${await response.text()}`,
    );
  }

  const result =
    (await response.json()) as UploadedComfyImage;

  if (!result.name) {
    throw new Error(
      'ComfyUI image upload did not return a filename.',
    );
  }

  return result;
}

function comfyImageReference(
  upload: UploadedComfyImage,
): string {
  return upload.subfolder
    ? `${upload.subfolder}/${upload.name}`
    : upload.name;
}

function pruneSecondImageBranch(
  workflow: ComfyWorkflow,
): void {
  for (const id of Object.keys(workflow)) {
    if (
      id === '81' ||
      id === '94' ||
      id.startsWith('92:')
    ) {
      delete workflow[id];
    }
  }
}

function configureTextToImageWorkflow(
  workflow: ComfyWorkflow,
  options: ImageGenerationOptions,
): {
  outputNodeId: string;
  width: number;
  height: number;
} {
  const positivePrompt =
    findNodeByTitle(
      workflow,
      'CLIP Text Encode (Positive Prompt)',
    );

  const negativePrompt =
    findNodeByTitle(
      workflow,
      'CLIP Text Encode (Negative Prompt)',
    );

  const widthNode =
    findNodeByTitle(workflow, 'Width');

  const heightNode =
    findNodeByTitle(workflow, 'Height');

  const randomNoise =
    findNodeByTitle(workflow, 'RandomNoise');

  const saveImage =
    findNodeByTitle(workflow, 'Save Image');

  const width =
    options.width ?? 1024;

  const height =
    options.height ?? 1024;

  positivePrompt.inputs.text =
    options.prompt;

  negativePrompt.inputs.text =
    options.negativePrompt ??
    'text, letters, words, labels, typography, watermark, blurry, distorted, low quality';

  widthNode.inputs.value = width;
  heightNode.inputs.value = height;

  randomNoise.inputs.noise_seed =
    getRandomSeed();

  saveImage.inputs.filename_prefix =
    'NeoAcademy/Flux';

  return {
    outputNodeId: '9',
    width,
    height,
  };
}

async function configureSingleImageEditWorkflow(
  workflow: ComfyWorkflow,
  baseUrl: string,
  options: ImageGenerationOptions,
): Promise<{
  outputNodeId: string;
  width: number;
  height: number;
}> {
  if (!options.inputImageBase64) {
    throw new Error(
      'Single-image editing requires inputImageBase64.',
    );
  }

  pruneSecondImageBranch(workflow);

  const uploaded =
    await uploadImageToComfyUi(
      baseUrl,
      options.inputImageBase64,
      'neoacademy-flux-input-1',
    );

  getNode(workflow, '76').inputs.image =
    comfyImageReference(uploaded);

  getNode(workflow, '75:74').inputs.text =
    options.prompt;

  getNode(workflow, '75:67').inputs.text =
    options.negativePrompt ??
    'text, letters, words, labels, typography, watermark, blurry, distorted, low quality';

  getNode(
    workflow,
    '75:73',
  ).inputs.noise_seed =
    getRandomSeed();

  getNode(
    workflow,
    '9',
  ).inputs.filename_prefix =
    'NeoAcademy/Flux-Edit';

  const width =
    options.width ?? 1024;

  const height =
    options.height ?? 1024;

  getNode(
    workflow,
    '75:80',
  ).inputs.megapixels =
    (width * height) / 1_000_000;

  return {
    outputNodeId: '9',
    width,
    height,
  };
}

async function configureTwoImageEditWorkflow(
  workflow: ComfyWorkflow,
  baseUrl: string,
  options: ImageGenerationOptions,
): Promise<{
  outputNodeId: string;
  width: number;
  height: number;
}> {
  if (!options.inputImageBase64) {
    throw new Error(
      'Two-image editing requires inputImageBase64.',
    );
  }

  if (!options.secondImageBase64) {
    throw new Error(
      'Two-image editing requires secondImageBase64.',
    );
  }

  if (!options.secondPrompt?.trim()) {
    throw new Error(
      'Two-image editing requires secondPrompt.',
    );
  }

  const firstUpload =
    await uploadImageToComfyUi(
      baseUrl,
      options.inputImageBase64,
      'neoacademy-flux-input-1',
    );

  const secondUpload =
    await uploadImageToComfyUi(
      baseUrl,
      options.secondImageBase64,
      'neoacademy-flux-input-2',
    );

  getNode(workflow, '76').inputs.image =
    comfyImageReference(firstUpload);

  getNode(workflow, '81').inputs.image =
    comfyImageReference(secondUpload);

  getNode(workflow, '75:74').inputs.text =
    options.prompt;

  getNode(workflow, '92:113').inputs.text =
    options.secondPrompt;

  const negative =
    options.negativePrompt ??
    'text, letters, words, labels, typography, watermark, blurry, distorted, low quality';

  getNode(workflow, '75:67').inputs.text =
    negative;

  getNode(workflow, '92:87').inputs.text =
    negative;

  getNode(
    workflow,
    '75:73',
  ).inputs.noise_seed =
    getRandomSeed();

  getNode(
    workflow,
    '92:105',
  ).inputs.noise_seed =
    getRandomSeed();

  getNode(
    workflow,
    '9',
  ).inputs.filename_prefix =
    'NeoAcademy/Flux-Edit-Intermediate';

  getNode(
    workflow,
    '94',
  ).inputs.filename_prefix =
    'NeoAcademy/Flux-Combined';

  const width =
    options.width ?? 1024;

  const height =
    options.height ?? 1024;

  const megapixels =
    (width * height) / 1_000_000;

  getNode(
    workflow,
    '75:80',
  ).inputs.megapixels =
    megapixels;

  getNode(
    workflow,
    '92:110',
  ).inputs.megapixels =
    megapixels;

  getNode(
    workflow,
    '92:85',
  ).inputs.megapixels =
    megapixels;

  return {
    outputNodeId: '94',
    width,
    height,
  };
}

async function waitForImageOutput(
  baseUrl: string,
  promptId: string,
  outputNodeId: string,
): Promise<ComfyUiImageAsset> {
  for (
    let attempt = 0;
    attempt < 300;
    attempt += 1
  ) {
    await new Promise(
      (resolve) => setTimeout(resolve, 1000),
    );

    const historyResponse =
      await fetch(
        `${baseUrl}/history/${promptId}`,
      );

    if (!historyResponse.ok) {
      continue;
    }

    const history =
      (await historyResponse.json()) as Record<
        string,
        {
          status?: {
            status_str?: string;
            completed?: boolean;
            messages?: unknown[];
          };
          outputs?: Record<
            string,
            {
              images?: Array<{
                filename: string;
                subfolder: string;
                type: string;
              }>;
            }
          >;
        }
      >;

    const promptHistory =
      history[promptId];

    if (!promptHistory) {
      continue;
    }

    const output =
      promptHistory.outputs?.[outputNodeId];

    const image =
      output?.images?.[0];

    if (image) {
      return {
        filename: image.filename,
        subfolder:
          image.subfolder || '',
        type:
          image.type || 'output',
      };
    }

    if (
      promptHistory.status?.completed === true
    ) {
      throw new Error(
        `ComfyUI completed image generation without producing expected output node ${outputNodeId}: ${promptId}`,
      );
    }
  }

  throw new Error(
    `Timed out waiting for ComfyUI image generation: ${promptId}`,
  );
}

async function downloadComfyUiImage(
  baseUrl: string,
  image: ComfyUiImageAsset,
): Promise<string> {
  const params =
    new URLSearchParams({
      filename: image.filename,
      subfolder:
        image.subfolder || '',
      type:
        image.type || 'output',
    });

  const response =
    await fetch(
      `${baseUrl}/view?${params.toString()}`,
    );

  if (!response.ok) {
    throw new Error(
      `ComfyUI image download failed: HTTP ${response.status}`,
    );
  }

  const arrayBuffer =
    await response.arrayBuffer();

  return Buffer.from(
    arrayBuffer,
  ).toString('base64');
}

export async function testComfyUiConnectivity(
  config: ImageGenerationConfig,
): Promise<{
  success: boolean;
  message: string;
}> {
  const baseUrl =
    resolveBaseUrl(config);

  try {
    const response =
      await fetch(
        `${baseUrl}/system_stats`,
      );

    if (!response.ok) {
      return {
        success: false,
        message:
          `ComfyUI returned HTTP ${response.status}`,
      };
    }

    return {
      success: true,
      message: 'Connected to ComfyUI',
    };
  } catch (error) {
    return {
      success: false,
      message:
        `Unable to connect to ComfyUI: ${
          error instanceof Error
            ? error.message
            : String(error)
        }`,
    };
  }
}

export async function generateWithComfyUi(
  config: ImageGenerationConfig,
  options: ImageGenerationOptions,
): Promise<ComfyUiImageGenerationResult> {
  const baseUrl =
    resolveBaseUrl(config);

  const mode =
    resolveMode(options);

  const workflow =
    mode === 'text-to-image'
      ? cloneWorkflow(
          textToImageWorkflowTemplate,
        )
      : cloneWorkflow(
          imageEditWorkflowTemplate,
        );

  configureFluxModels(workflow);

  let configured: {
    outputNodeId: string;
    width: number;
    height: number;
  };

  if (mode === 'text-to-image') {
    configured =
      configureTextToImageWorkflow(
        workflow,
        options,
      );
  } else if (
    mode === 'single-image-edit'
  ) {
    configured =
      await configureSingleImageEditWorkflow(
        workflow,
        baseUrl,
        options,
      );
  } else {
    configured =
      await configureTwoImageEditWorkflow(
        workflow,
        baseUrl,
        options,
      );
  }

  const submitResponse =
    await fetch(
      `${baseUrl}/prompt`,
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/json',
        },
        body: JSON.stringify({
          prompt: workflow,
        }),
      },
    );

  if (!submitResponse.ok) {
    throw new Error(
      `ComfyUI prompt submission failed: HTTP ${submitResponse.status} ${await submitResponse.text()}`,
    );
  }

  const submitted =
    (await submitResponse.json()) as {
      prompt_id?: string;
    };

  if (!submitted.prompt_id) {
    throw new Error(
      'ComfyUI did not return a prompt_id',
    );
  }

  const image =
    await waitForImageOutput(
      baseUrl,
      submitted.prompt_id,
      configured.outputNodeId,
    );

  const base64 =
    await downloadComfyUiImage(
      baseUrl,
      image,
    );

  return {
    base64,
    width: configured.width,
    height: configured.height,
    comfyUiAsset: image,
  };
}