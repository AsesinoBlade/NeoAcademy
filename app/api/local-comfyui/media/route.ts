import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isSafeValue(value: string): boolean {
  return (
    value.length > 0 && !value.includes('..') && !value.includes('\\') && !value.startsWith('/')
  );
}

export async function GET(request: NextRequest) {
  try {
    const filename = request.nextUrl.searchParams.get('filename') || '';
    const subfolder = request.nextUrl.searchParams.get('subfolder') || '';
    const type = request.nextUrl.searchParams.get('type') || 'output';

    if (!isSafeValue(filename)) {
      return NextResponse.json(
        { success: false, error: 'Invalid ComfyUI filename' },
        { status: 400 },
      );
    }

    if (subfolder && (!isSafeValue(subfolder) || subfolder.includes('/'))) {
      return NextResponse.json(
        { success: false, error: 'Invalid ComfyUI subfolder' },
        { status: 400 },
      );
    }

    if (!['output', 'temp', 'input'].includes(type)) {
      return NextResponse.json(
        { success: false, error: 'Invalid ComfyUI file type' },
        { status: 400 },
      );
    }

    const baseUrl = (
      process.env.VIDEO_COMFYUI_BASE_URL ||
      process.env.IMAGE_COMFYUI_BASE_URL ||
      'http://127.0.0.1:8188'
    ).replace(/\/$/, '');

    const params = new URLSearchParams({
      filename,
      subfolder,
      type,
    });

    const response = await fetch(`${baseUrl}/view?${params.toString()}`);

    if (!response.ok) {
      return NextResponse.json(
        {
          success: false,
          error: `ComfyUI media download failed: HTTP ${response.status}`,
        },
        { status: 502 },
      );
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';

    return new NextResponse(response.body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
