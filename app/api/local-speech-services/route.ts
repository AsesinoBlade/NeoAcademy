import { NextRequest, NextResponse } from 'next/server';

import {
  getLocalSpeechServicesStatus,
  startLocalSpeechServices,
  stopLocalSpeechServices,
} from '@/lib/server/local-speech-services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json({
      success: true,
      ...(await getLocalSpeechServicesStatus()),
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
      return NextResponse.json(await startLocalSpeechServices());
    }

    if (body.action === 'stop') {
      return NextResponse.json(await stopLocalSpeechServices());
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
