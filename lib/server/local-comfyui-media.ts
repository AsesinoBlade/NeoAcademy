import fs from 'node:fs/promises';
import path from 'node:path';

type ComfyUiFileType = 'output' | 'input' | 'temp';

interface ComfyUiAsset {
  filename: string;
  subfolder?: string;
  type?: string;
}

function isSafeValue(value: string): boolean {
  return (
    value.length > 0 && !value.includes('..') && !value.includes('\\') && !value.startsWith('/')
  );
}

function isLocalComfyUiUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);

    return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  } catch {
    return false;
  }
}

export async function deleteLocalComfyUiAsset(
  baseUrl: string,
  asset: ComfyUiAsset,
): Promise<boolean> {
  if (!isLocalComfyUiUrl(baseUrl)) {
    return false;
  }

  const root = process.env.COMFYUI_ROOT;

  if (!root) {
    return false;
  }

  if (!isSafeValue(asset.filename)) {
    return false;
  }

  const subfolder = asset.subfolder || '';

  if (subfolder && (!isSafeValue(subfolder) || subfolder.includes('/'))) {
    return false;
  }

  const type = (asset.type || 'output') as ComfyUiFileType;

  if (!['output', 'input', 'temp'].includes(type)) {
    return false;
  }

  const typeRoot = path.resolve(root, 'ComfyUI', type);
  const filePath = path.resolve(typeRoot, subfolder, asset.filename);

  const relativePath = path.relative(typeRoot, filePath);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return false;
  }

  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}
