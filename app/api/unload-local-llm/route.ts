import { NextResponse } from 'next/server';

import { unloadLocalLlm } from '@/lib/server/local-llm';

export async function POST() {
  const result = await unloadLocalLlm();

  if (!result.success) {
    return NextResponse.json(result, {
      status: 500,
    });
  }

  return NextResponse.json(result);
}
