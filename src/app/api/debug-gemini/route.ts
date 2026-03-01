import { NextResponse } from 'next/server';

export async function GET() {
  const apiKey = process.env.GEMINI_API_KEY;
  const result: Record<string, unknown> = {
    keyPresent: !!apiKey,
    keyPrefix: apiKey?.substring(0, 10),
  };

  if (!apiKey) {
    return NextResponse.json({ ...result, error: 'No GEMINI_API_KEY' });
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { GoogleGenAI } = require('@google/genai') as typeof import('@google/genai');
    const ai = new GoogleGenAI({ apiKey });

    const res = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: '次のJSONを返してください: {"status": "ok", "model": "gemini-2.5-flash"}',
      config: {
        responseMimeType: 'application/json',
        temperature: 0,
        maxOutputTokens: 100,
      },
    });

    result.rawText = res.text;
    result.parsed = JSON.parse(res.text || '{}');
    result.success = true;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    result.success = false;
  }

  return NextResponse.json(result);
}
