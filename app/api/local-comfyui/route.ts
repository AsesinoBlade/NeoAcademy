import { NextRequest, NextResponse } from 'next/server';

import {
  getLocalComfyUiStatus,
  startLocalComfyUi,
  stopLocalComfyUi,
} from '@/lib/server/local-comfyui';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json({
      success: true,
      ...(await getLocalComfyUiStatus()),
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

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      action?: 'start' | 'stop';
    };

    if (body.action === 'start') {
      return NextResponse.json(await startLocalComfyUi());
    }

    if (body.action === 'stop') {
      return NextResponse.json(await stopLocalComfyUi());
    }

    return NextResponse.json(
      {
        success: false,
        error: 'action must be "start" or "stop"',
      },
      { status: 400 },
    );
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
