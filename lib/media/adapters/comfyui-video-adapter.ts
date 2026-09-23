import workflowTemplate from '../../../config/comfyui/neoacademy-video-wan22-api.json';
import continuationWorkflowTemplate from '../../../config/comfyui/neoacademy-video-wan22-continuation-api.json';
import ltxTextToVideoWorkflowTemplate from '../../../config/comfyui/neoacademy-video-ltx-t2v-api.json';
import ltxImageToVideoWorkflowTemplate from '../../../config/comfyui/neoacademy-video-ltx-i2v-api.json';
import crypto from 'node:crypto';

import type {
  VideoGenerationConfig,
  VideoGenerationOptions,
  VideoGenerationResult,
} from '../types';

type WorkflowNode = {
  inputs?: Record<string, unknown>;
  class_type?: string;
  _meta?: { title?: string };
};

type ComfyUiAsset = {
  filename: string;
  subfolder?: string;
  type?: string;
};

export type ComfyUiVideoAssetCleanup = (assets: {
  output: ComfyUiAsset;
  input?: ComfyUiAsset;
}) => Promise<void>;

type Workflow = Record<string, WorkflowNode>;

type ComfyUiUploadedImage = {
  name: string;
  subfolder: string;
  type: string;
};

async function uploadImageToComfyUi(
  baseUrl: string,
  imagePath: string,
): Promise<ComfyUiUploadedImage> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  const imageBuffer = await fs.readFile(imagePath);
  const form = new FormData();

  form.append('image', new Blob([imageBuffer]), path.basename(imagePath));
  form.append('type', 'input');
  form.append('overwrite', 'true');

  const response = await fetch(`${baseUrl}/upload/image`, {
    method: 'POST',
    body: form,
  });

  if (!response.ok) {
    throw new Error(`ComfyUI image upload failed: HTTP ${response.status}`);
  }

  const data = (await response.json()) as Partial<ComfyUiUploadedImage>;

  if (!data.name) {
    throw new Error('ComfyUI image upload returned no filename');
  }

  return {
    name: data.name,
    subfolder: data.subfolder || '',
    type: data.type || 'input',
  };
}

function getBaseUrl(config: VideoGenerationConfig) {
  return (config.baseUrl || process.env.VIDEO_COMFYUI_BASE_URL || 'http://127.0.0.1:8188').replace(
    /\/$/,
    '',
  );
}

function cloneWorkflow(): Workflow {
  return JSON.parse(JSON.stringify(workflowTemplate)) as Workflow;
}

function cloneContinuationWorkflow(): Workflow {
  return JSON.parse(JSON.stringify(continuationWorkflowTemplate)) as Workflow;
}

function cloneLtxTextToVideoWorkflow(): Workflow {
  return JSON.parse(JSON.stringify(ltxTextToVideoWorkflowTemplate)) as Workflow;
}

function cloneLtxImageToVideoWorkflow(): Workflow {
  return JSON.parse(JSON.stringify(ltxImageToVideoWorkflowTemplate)) as Workflow;
}

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function findNodeIdByTitle(workflow: Workflow, title: string): string {
  const entry = Object.entries(workflow).find(([, node]) => node?._meta?.title === title);

  if (!entry) {
    throw new Error(`ComfyUI workflow node not found: ${title}`);
  }

  return entry[0];
}

function findNodeIdByClassType(workflow: Workflow, classType: string): string {
  const entry = Object.entries(workflow).find(([, node]) => node?.class_type === classType);

  if (!entry) {
    throw new Error(`ComfyUI workflow node type not found: ${classType}`);
  }

  return entry[0];
}

function getReferencedNodeId(
  workflow: Workflow,
  sourceNodeId: string,
  inputName: string,
): string {
  const reference = workflow[sourceNodeId]?.inputs?.[inputName];

  if (
    !Array.isArray(reference) ||
    typeof reference[0] !== 'string' ||
    !workflow[reference[0]]
  ) {
    throw new Error(
      `ComfyUI workflow input ${sourceNodeId}.${inputName} does not reference a node`,
    );
  }

  return reference[0];
}

function configureLtxWorkflowModels(workflow: Workflow): void {
  const diffusionModel = getRequiredEnv('VIDEO_LTX_DIFFUSION_MODEL');
  const textEncoder = getRequiredEnv('VIDEO_LTX_TEXT_ENCODER');
  const promptEnhanceEncoder = getRequiredEnv('VIDEO_LTX_PROMPT_ENHANCE_ENCODER');
  const videoVae = getRequiredEnv('VIDEO_LTX_VIDEO_VAE');
  const audioVae = getRequiredEnv('VIDEO_LTX_AUDIO_VAE');
  const upscaler = getRequiredEnv('VIDEO_LTX_UPSCALER');

  const promptEnhancerId = findNodeIdByClassType(workflow, 'TextGenerateLTX2Prompt');
  const promptEnhanceEncoderId = getReferencedNodeId(workflow, promptEnhancerId, 'clip');

  const textEncodeId = findNodeIdByClassType(workflow, 'CLIPTextEncode');
  const textEncoderId = getReferencedNodeId(workflow, textEncodeId, 'clip');

  const latentUpsamplerId = findNodeIdByClassType(workflow, 'LTXVLatentUpsampler');
  const upscalerId = getReferencedNodeId(workflow, latentUpsamplerId, 'upscale_model');
  const videoVaeId = getReferencedNodeId(workflow, latentUpsamplerId, 'vae');

  const audioDecodeId = findNodeIdByClassType(workflow, 'LTXVAudioVAEDecode');
  const audioVaeId = getReferencedNodeId(workflow, audioDecodeId, 'audio_vae');

  const guiderId = findNodeIdByClassType(workflow, 'LTXVDualCFGGuider');
  const diffusionModelId = getReferencedNodeId(workflow, guiderId, 'model');

  workflow[diffusionModelId].inputs!.unet_name = diffusionModel;
  workflow[textEncoderId].inputs!.clip_name = textEncoder;
  workflow[promptEnhanceEncoderId].inputs!.clip_name = promptEnhanceEncoder;
  workflow[videoVaeId].inputs!.vae_name = videoVae;
  workflow[audioVaeId].inputs!.vae_name = audioVae;
  workflow[upscalerId].inputs!.model_name = upscaler;

  const promptEnhanceSwitchId = findNodeIdByTitle(
    workflow,
    'Boolean (Enable Prompt Enhance)',
  );

  workflow[promptEnhanceSwitchId].inputs!.value =
    process.env.VIDEO_LTX_ENABLE_PROMPT_ENHANCE !== 'false';
}
function buildLocalVideoUrl(asset: { filename: string; subfolder?: string; type?: string }) {
  const params = new URLSearchParams({
    filename: asset.filename,
    subfolder: asset.subfolder || '',
    type: asset.type || 'output',
  });

  return `/api/local-comfyui/media?${params.toString()}`;
}

async function downloadComfyUiAssetToFile(
  baseUrl: string,
  asset: {
    filename: string;
    subfolder?: string;
    type?: string;
  },
  outputPath: string,
): Promise<string> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const params = new URLSearchParams({
    filename: asset.filename,
    subfolder: asset.subfolder || '',
    type: asset.type || 'output',
  });

  const response = await fetch(`${baseUrl}/view?${params.toString()}`);

  if (!response.ok) {
    throw new Error(`ComfyUI media download failed: HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(outputPath, buffer);

  return outputPath;
}

export async function testComfyUiVideoConnectivity(
  config: VideoGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  try {
    const response = await fetch(`${getBaseUrl(config)}/system_stats`);
    if (!response.ok) {
      return {
        success: false,
        message: `ComfyUI returned HTTP ${response.status}`,
      };
    }

    return { success: true, message: 'Connected to ComfyUI video backend' };
  } catch (error) {
    return {
      success: false,
      message: `Unable to connect to ComfyUI: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export async function generateWithComfyUiLtxImageToVideo(
  config: VideoGenerationConfig,
  options: VideoGenerationOptions,
  startImagePath: string,
  outputPath?: string,
  cleanupAssets?: ComfyUiVideoAssetCleanup,
): Promise<VideoGenerationResult> {
  const baseUrl = getBaseUrl(config);
  const uploadedImage = await uploadImageToComfyUi(baseUrl, startImagePath);
  const workflow = cloneLtxImageToVideoWorkflow();

  configureLtxWorkflowModels(workflow);

  const promptNodeId = findNodeIdByTitle(workflow, 'Prompt');
  const durationNodeId = findNodeIdByTitle(workflow, 'Duration');
  const widthNodeId = findNodeIdByTitle(workflow, 'Width');
  const heightNodeId = findNodeIdByTitle(workflow, 'Height');
  const frameRateNodeId = findNodeIdByTitle(workflow, 'Frame Rate');
  const loadImageNodeId = findNodeIdByTitle(workflow, 'Load First Frame');
  const t2vSwitchNodeId = findNodeIdByTitle(workflow, 'Switch to Text to Video?');
  const saveVideoNodeId = findNodeIdByTitle(workflow, 'Save Video');

  const duration = options.duration ?? 30;

  let width = 1280;
  let height = 704;

  if (options.resolution === '1080p') {
    width = 1920;
    height = 1080;
  } else if (options.resolution === '480p') {
    width = 608;
    height = 352;
  }

  workflow[promptNodeId].inputs!.value = options.prompt;
  workflow[durationNodeId].inputs!.value = duration;
  workflow[widthNodeId].inputs!.value = width;
  workflow[heightNodeId].inputs!.value = height;
  workflow[frameRateNodeId].inputs!.value = 24;
  workflow[loadImageNodeId].inputs!.image = uploadedImage.name;
  workflow[t2vSwitchNodeId].inputs!.value = false;
  workflow[saveVideoNodeId].inputs!.filename_prefix = `video/NeoAcademy_LTX_${Date.now()}`;

  for (const node of Object.values(workflow)) {
    if (node.class_type === 'RandomNoise' && node.inputs) {
      node.inputs.noise_seed = Number(crypto.randomInt(1, 2_147_483_647));
    }
  }

  const submitResponse = await fetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
  });

  if (!submitResponse.ok) {
    const detail = await submitResponse.text();

    throw new Error(
      `ComfyUI LTX image-to-video submission failed: HTTP ${submitResponse.status}: ${detail}`,
    );
  }

  const submitData = (await submitResponse.json()) as { prompt_id?: string };

  if (!submitData.prompt_id) {
    throw new Error('ComfyUI did not return a prompt_id for LTX image-to-video generation');
  }

  const promptId = submitData.prompt_id;
  const deadline = Date.now() + 2 * 60 * 60 * 1000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const historyResponse = await fetch(`${baseUrl}/history/${promptId}`);

    if (!historyResponse.ok) {
      continue;
    }

    const history = (await historyResponse.json()) as Record<
      string,
      {
        outputs?: Record<
          string,
          {
            gifs?: ComfyUiAsset[];
            videos?: ComfyUiAsset[];
            images?: ComfyUiAsset[];
          }
        >;
        status?: {
          completed?: boolean;
          status_str?: string;
        };
      }
    >;

    const run = history[promptId];
    const saveOutput = run?.outputs?.[saveVideoNodeId];

    const asset =
      saveOutput?.videos?.[0] ||
      saveOutput?.gifs?.[0] ||
      saveOutput?.images?.[0];

    if (asset) {
      if (outputPath) {
        await downloadComfyUiAssetToFile(baseUrl, asset, outputPath);

        if (cleanupAssets) {
          await cleanupAssets({
            output: asset,
            input: {
              filename: uploadedImage.name,
              subfolder: uploadedImage.subfolder,
              type: uploadedImage.type,
            },
          });
        }
      }

      return {
        url: buildLocalVideoUrl(asset),
        duration,
        width,
        height,
      };
    }

    if (run?.status?.completed) {
      throw new Error(
        `ComfyUI LTX image-to-video generation completed with status "${
          run.status.status_str || 'unknown'
        }" but no output video was found`,
      );
    }
  }

  throw new Error('Timed out waiting for ComfyUI LTX image-to-video generation');
}
export async function generateWithComfyUiLtxTextToVideo(
  config: VideoGenerationConfig,
  options: VideoGenerationOptions,
  outputPath?: string,
  cleanupAssets?: ComfyUiVideoAssetCleanup,
): Promise<VideoGenerationResult> {
  const baseUrl = getBaseUrl(config);
  const workflow = cloneLtxTextToVideoWorkflow();

  configureLtxWorkflowModels(workflow);

  const promptNodeId = findNodeIdByTitle(workflow, 'Prompt');
  const durationNodeId = findNodeIdByTitle(workflow, 'Duration');
  const widthNodeId = findNodeIdByTitle(workflow, 'Width');
  const heightNodeId = findNodeIdByTitle(workflow, 'Height');
  const frameRateNodeId = findNodeIdByTitle(workflow, 'Frame Rate');
  const saveVideoNodeId = findNodeIdByTitle(workflow, 'Save Video');

  const duration = options.duration ?? 30;

  let width = 1280;
  let height = 704;

  if (options.resolution === '1080p') {
    width = 1920;
    height = 1080;
  } else if (options.resolution === '480p') {
    width = 608;
    height = 352;
  }

  workflow[promptNodeId].inputs!.value = options.prompt;
  workflow[durationNodeId].inputs!.value = duration;
  workflow[widthNodeId].inputs!.value = width;
  workflow[heightNodeId].inputs!.value = height;
  workflow[frameRateNodeId].inputs!.value = 24;
  workflow[saveVideoNodeId].inputs!.filename_prefix = `video/NeoAcademy_LTX_${Date.now()}`;

  for (const node of Object.values(workflow)) {
    if (node.class_type === 'RandomNoise' && node.inputs) {
      node.inputs.noise_seed = Number(crypto.randomInt(1, 2_147_483_647));
    }
  }

  const submitResponse = await fetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
  });

  if (!submitResponse.ok) {
    const detail = await submitResponse.text();

    throw new Error(
      `ComfyUI LTX prompt submission failed: HTTP ${submitResponse.status}: ${detail}`,
    );
  }

  const submitData = (await submitResponse.json()) as { prompt_id?: string };

  if (!submitData.prompt_id) {
    throw new Error('ComfyUI did not return a prompt_id for LTX generation');
  }

  const promptId = submitData.prompt_id;
  const deadline = Date.now() + 2 * 60 * 60 * 1000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const historyResponse = await fetch(`${baseUrl}/history/${promptId}`);

    if (!historyResponse.ok) {
      continue;
    }

    const history = (await historyResponse.json()) as Record<
      string,
      {
        outputs?: Record<
          string,
          {
            gifs?: ComfyUiAsset[];
            videos?: ComfyUiAsset[];
            images?: ComfyUiAsset[];
          }
        >;
        status?: {
          completed?: boolean;
          status_str?: string;
        };
      }
    >;

    const run = history[promptId];
    const saveOutput = run?.outputs?.[saveVideoNodeId];

    const asset =
      saveOutput?.videos?.[0] ||
      saveOutput?.gifs?.[0] ||
      saveOutput?.images?.[0];

    if (asset) {
      if (outputPath) {
        await downloadComfyUiAssetToFile(baseUrl, asset, outputPath);

        if (cleanupAssets) {
          await cleanupAssets({
            output: asset,
          });
        }
      }

      return {
        url: buildLocalVideoUrl(asset),
        duration,
        width,
        height,
      };
    }

    if (run?.status?.completed) {
      throw new Error(
        `ComfyUI LTX generation completed with status "${
          run.status.status_str || 'unknown'
        }" but no output video was found`,
      );
    }
  }

  throw new Error('Timed out waiting for ComfyUI LTX video generation');
}
export async function generateWithComfyUiVideo(
  config: VideoGenerationConfig,
  options: VideoGenerationOptions,
  outputPath?: string,
  cleanupAssets?: ComfyUiVideoAssetCleanup,
): Promise<VideoGenerationResult> {
  const baseUrl = getBaseUrl(config);
  const workflow = cloneWorkflow();

  const promptNodeId = findNodeIdByTitle(workflow, 'NeoAcademy Positive Prompt');
  const latentNodeId = findNodeIdByTitle(workflow, 'NeoAcademy Video Latent');
  const createVideoNodeId = findNodeIdByTitle(workflow, 'NeoAcademy Create Video');
  const saveVideoNodeId = findNodeIdByTitle(workflow, 'NeoAcademy Save Video');
  const samplerNodeId = findNodeIdByTitle(workflow, 'NeoAcademy Sampler');

  workflow[promptNodeId].inputs!.text = options.prompt;
  workflow[samplerNodeId].inputs!.seed = Number(crypto.randomInt(1, 2_147_483_647));
  workflow[latentNodeId].inputs!.width = 1280;
  workflow[latentNodeId].inputs!.height = 704;
  workflow[latentNodeId].inputs!.length = 121;
  workflow[createVideoNodeId].inputs!.fps = 24;
  workflow[saveVideoNodeId].inputs!.filename_prefix = `video/NeoAcademy_${Date.now()}`;

  const submitResponse = await fetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
  });

  if (!submitResponse.ok) {
    throw new Error(`ComfyUI prompt submission failed: HTTP ${submitResponse.status}`);
  }

  const submitData = (await submitResponse.json()) as { prompt_id?: string };
  if (!submitData.prompt_id) {
    throw new Error('ComfyUI did not return a prompt_id');
  }

  const promptId = submitData.prompt_id;
  const deadline = Date.now() + 30 * 60 * 1000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const historyResponse = await fetch(`${baseUrl}/history/${promptId}`);
    if (!historyResponse.ok) continue;

    const history = (await historyResponse.json()) as Record<
      string,
      {
        outputs?: Record<
          string,
          {
            gifs?: Array<{ filename: string; subfolder?: string; type?: string }>;
            videos?: Array<{ filename: string; subfolder?: string; type?: string }>;
            images?: Array<{ filename: string; subfolder?: string; type?: string }>;
          }
        >;
        status?: {
          completed?: boolean;
          status_str?: string;
        };
      }
    >;

    const run = history[promptId];
    const saveOutput = run?.outputs?.[saveVideoNodeId];

    const asset = saveOutput?.videos?.[0] || saveOutput?.gifs?.[0] || saveOutput?.images?.[0];

    if (asset) {
      if (outputPath) {
        await downloadComfyUiAssetToFile(baseUrl, asset, outputPath);

        if (cleanupAssets) {
          await cleanupAssets({
            output: asset,
          });
        }
      }

      return {
        url: buildLocalVideoUrl(asset),
        duration: 5,
        width: 1280,
        height: 704,
      };
    }

    if (run?.status?.completed) {
      throw new Error(
        `ComfyUI video generation completed with status "${run.status.status_str || 'unknown'}" but no output file was found`,
      );
    }
  }

  throw new Error('Timed out waiting for ComfyUI video generation');
}

export async function generateWithComfyUiVideoContinuation(
  config: VideoGenerationConfig,
  options: VideoGenerationOptions,
  startImagePath: string,
  outputPath?: string,
  cleanupAssets?: ComfyUiVideoAssetCleanup,
): Promise<VideoGenerationResult> {
  const baseUrl = getBaseUrl(config);
  const uploadedImage = await uploadImageToComfyUi(baseUrl, startImagePath);
  const workflow = cloneContinuationWorkflow();

  const promptNodeId = findNodeIdByTitle(workflow, 'NeoAcademy Positive Prompt');
  const latentNodeId = findNodeIdByTitle(workflow, 'NeoAcademy Video Latent');
  const loadImageNodeId = findNodeIdByTitle(workflow, 'NeoAcademy Continuation Start Image');
  const createVideoNodeId = findNodeIdByTitle(workflow, 'NeoAcademy Create Video');
  const saveVideoNodeId = findNodeIdByTitle(workflow, 'NeoAcademy Save Video');
  const samplerNodeId = findNodeIdByTitle(workflow, 'NeoAcademy Sampler');

  workflow[promptNodeId].inputs!.text = options.prompt;
  workflow[loadImageNodeId].inputs!.image = uploadedImage.name;
  workflow[latentNodeId].inputs!.start_image = [loadImageNodeId, 0];

  workflow[samplerNodeId].inputs!.seed = Number(crypto.randomInt(1, 2_147_483_647));

  workflow[latentNodeId].inputs!.width = 1280;
  workflow[latentNodeId].inputs!.height = 704;
  workflow[latentNodeId].inputs!.length = 121;
  workflow[createVideoNodeId].inputs!.fps = 24;
  workflow[saveVideoNodeId].inputs!.filename_prefix = `video/NeoAcademy_${Date.now()}`;

  const submitResponse = await fetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
  });

  if (!submitResponse.ok) {
    throw new Error(`ComfyUI continuation prompt submission failed: HTTP ${submitResponse.status}`);
  }

  const submitData = (await submitResponse.json()) as { prompt_id?: string };

  if (!submitData.prompt_id) {
    throw new Error('ComfyUI did not return a prompt_id');
  }

  const promptId = submitData.prompt_id;
  const deadline = Date.now() + 30 * 60 * 1000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const historyResponse = await fetch(`${baseUrl}/history/${promptId}`);
    if (!historyResponse.ok) continue;

    const history = (await historyResponse.json()) as Record<
      string,
      {
        outputs?: Record<
          string,
          {
            gifs?: Array<{
              filename: string;
              subfolder?: string;
              type?: string;
            }>;
            videos?: Array<{
              filename: string;
              subfolder?: string;
              type?: string;
            }>;
            images?: Array<{
              filename: string;
              subfolder?: string;
              type?: string;
            }>;
          }
        >;
        status?: {
          completed?: boolean;
          status_str?: string;
        };
      }
    >;

    const run = history[promptId];
    const saveOutput = run?.outputs?.[saveVideoNodeId];

    const asset = saveOutput?.videos?.[0] || saveOutput?.gifs?.[0] || saveOutput?.images?.[0];

    if (asset) {
      if (outputPath) {
        await downloadComfyUiAssetToFile(baseUrl, asset, outputPath);

        if (cleanupAssets) {
          await cleanupAssets({
            output: asset,
            input: {
              filename: uploadedImage.name,
              subfolder: uploadedImage.subfolder,
              type: uploadedImage.type,
            },
          });
        }
      }

      return {
        url: buildLocalVideoUrl(asset),
        duration: 5,
        width: 1280,
        height: 704,
      };
    }

    if (run?.status?.completed) {
      throw new Error(
        `ComfyUI continuation generation completed with status "${
          run.status.status_str || 'unknown'
        }" but no output file was found`,
      );
    }
  }

  throw new Error('Timed out waiting for ComfyUI continuation generation');
}
