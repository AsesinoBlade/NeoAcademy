import workflowTemplate from '../../../config/comfyui/neoacademy-video-wan22-api.json';
import crypto from 'node:crypto';

import type {
  VideoGenerationConfig,
  VideoGenerationOptions,
  VideoGenerationResult,
} from '../types';

type WorkflowNode = {
  inputs?: Record<string, unknown>;
  _meta?: { title?: string };
};

type Workflow = Record<string, WorkflowNode>;

function getBaseUrl(config: VideoGenerationConfig) {
  return (config.baseUrl || process.env.VIDEO_COMFYUI_BASE_URL || 'http://127.0.0.1:8188').replace(
    /\/$/,
    '',
  );
}

function cloneWorkflow(): Workflow {
  return JSON.parse(JSON.stringify(workflowTemplate)) as Workflow;
}

function findNodeIdByTitle(workflow: Workflow, title: string): string {
  const entry = Object.entries(workflow).find(([, node]) => node?._meta?.title === title);

  if (!entry) {
    throw new Error(`ComfyUI workflow node not found: ${title}`);
  }

  return entry[0];
}

function buildLocalVideoUrl(asset: { filename: string; subfolder?: string; type?: string }) {
  const params = new URLSearchParams({
    filename: asset.filename,
    subfolder: asset.subfolder || '',
    type: asset.type || 'output',
  });

  return `/api/local-comfyui/media?${params.toString()}`;
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

export async function generateWithComfyUiVideo(
  config: VideoGenerationConfig,
  options: VideoGenerationOptions,
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
  const deadline = Date.now() + 10 * 60 * 1000;

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
