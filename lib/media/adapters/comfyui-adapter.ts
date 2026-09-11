import type {
  ImageGenerationConfig,
  ImageGenerationOptions,
  ImageGenerationResult,
} from '../types';

import workflowTemplate from '../../../config/comfyui/text2img-sdxl-api.json';

type WorkflowNode = {
  inputs: Record<string, unknown>;
  class_type: string;
  _meta?: {
    title?: string;
  };
};

type ComfyWorkflow = Record<string, WorkflowNode>;

function cloneWorkflow(): ComfyWorkflow {
  return JSON.parse(JSON.stringify(workflowTemplate)) as ComfyWorkflow;
}

function findNodeByTitle(workflow: ComfyWorkflow, title: string): WorkflowNode {
  const node = Object.values(workflow).find((candidate) => candidate._meta?.title === title);

  if (!node) {
    throw new Error(`ComfyUI workflow node not found: ${title}`);
  }

  return node;
}

export async function testComfyUiConnectivity(
  config: ImageGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = config.baseUrl || 'http://127.0.0.1:8188';

  try {
    const response = await fetch(`${baseUrl}/system_stats`);

    if (!response.ok) {
      return {
        success: false,
        message: `ComfyUI returned HTTP ${response.status}`,
      };
    }

    return {
      success: true,
      message: 'Connected to ComfyUI',
    };
  } catch (error) {
    return {
      success: false,
      message: `Unable to connect to ComfyUI: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export async function generateWithComfyUi(
  config: ImageGenerationConfig,
  options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
  const baseUrl = config.baseUrl || 'http://127.0.0.1:8188';
  const workflow = cloneWorkflow();

  const positivePrompt = findNodeByTitle(workflow, 'NeoAcademy Positive Prompt');
  const negativePrompt = findNodeByTitle(workflow, 'NeoAcademy Negative Prompt');
  const imageSize = findNodeByTitle(workflow, 'NeoAcademy Image Size');
  const sampler = findNodeByTitle(workflow, 'NeoAcademy Sampler');
  const saveImage = findNodeByTitle(workflow, 'NeoAcademy Save Image');

  const width = options.width ?? 1024;
  const height = options.height ?? 1024;

  positivePrompt.inputs.text = options.prompt;

  negativePrompt.inputs.text =
    options.negativePrompt ??
    'text, letters, words, labels, typography, watermark, blurry, distorted, low quality';

  imageSize.inputs.width = width;
  imageSize.inputs.height = height;
  imageSize.inputs.batch_size = 1;

  sampler.inputs.seed = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);

  saveImage.inputs.filename_prefix = 'NeoAcademy';

  const submitResponse = await fetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt: workflow,
    }),
  });

  if (!submitResponse.ok) {
    throw new Error(
      `ComfyUI prompt submission failed: HTTP ${submitResponse.status} ${await submitResponse.text()}`,
    );
  }

  const submitted = (await submitResponse.json()) as {
    prompt_id?: string;
  };

  if (!submitted.prompt_id) {
    throw new Error('ComfyUI did not return a prompt_id');
  }

  const promptId = submitted.prompt_id;

  for (let attempt = 0; attempt < 300; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));

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
            images?: Array<{
              filename: string;
              subfolder: string;
              type: string;
            }>;
          }
        >;
      }
    >;

    const promptHistory = history[promptId];

    if (!promptHistory?.outputs) {
      continue;
    }

    const outputWithImage = Object.values(promptHistory.outputs).find(
      (output) => output.images && output.images.length > 0,
    );

    const image = outputWithImage?.images?.[0];

    if (!image) {
      continue;
    }

    const params = new URLSearchParams({
      filename: image.filename,
      subfolder: image.subfolder || '',
      type: image.type || 'output',
    });

    const imageResponse = await fetch(`${baseUrl}/view?${params.toString()}`);

    if (!imageResponse.ok) {
      throw new Error(`ComfyUI image download failed: HTTP ${imageResponse.status}`);
    }

    const arrayBuffer = await imageResponse.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');

    return {
      base64,
      width,
      height,
    };
  }

  throw new Error(`Timed out waiting for ComfyUI image generation: ${promptId}`);
}