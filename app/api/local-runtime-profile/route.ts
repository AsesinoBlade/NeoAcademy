import { NextResponse } from 'next/server';
import { getLocalRuntimeCapabilities } from '@/lib/server/local-runtime-profile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(getLocalRuntimeCapabilities());
}
