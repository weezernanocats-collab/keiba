import type { Prediction, PredictionPick, RaceAnalysis, RecommendedBet } from '@/types';

// ==================== Types ====================

export interface GeminiRaceContext {
  trackType: string;
  distance: number;
  trackCondition: string;
  racecourseName: string;
  grade?: string;
  horseScores: Array<{
    horseName: string;
    horseNumber: number;
    totalScore: number;
    factorScores: Record<string, number>;
    runningStyle: string;
    fatherName: string;
  }>;
}

interface GeminiEnhancedOutput {
  summary: string;
  picks: Array<{ horseNumber: number; reasons: string[] }>;
  trackBias: string;
  paceAnalysis: string;
  keyFactors: string[];
  riskFactors: string[];
  betReasonings: Array<{ type: string; reasoning: string }>;
}

// ==================== Factor labels ====================

const FACTOR_LABELS: Record<string, string> = {
  recentForm: '直近成績',
  courseAptitude: 'コース適性',
  distanceAptitude: '距離適性',
  trackConditionAptitude: '馬場適性',
  jockeyAbility: '騎手',
  speedRating: 'スピード指数',
  classPerformance: 'クラス実績',
  runningStyle: '脚質',
  postPositionBias: '枠順',
  rotation: 'ローテーション',
  lastThreeFurlongs: '上がり3F',
  consistency: '安定性',
  sireAptitude: '血統適性',
  jockeyTrainerCombo: '騎手×調教師',
  historicalPostBias: '統計枠バイアス',
  seasonalPattern: '季節パターン',
};

// ==================== Lazy singleton ====================

import { GoogleGenAI } from '@google/genai';

let genAIInstance: GoogleGenAI | null = null;

function getGenAI(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  if (genAIInstance) return genAIInstance;

  genAIInstance = new GoogleGenAI({ apiKey });
  return genAIInstance;
}

// ==================== Prompt construction ====================

function buildPrompt(prediction: Prediction, ctx: GeminiRaceContext): string {
  const marks = ['◎本命', '○対抗', '▲単穴', '△連下', '×注意', '☆穴'];

  const horsesText = ctx.horseScores.map((h, i) => {
    const topFactors = Object.entries(h.factorScores)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, v]) => `${FACTOR_LABELS[k] || k}:${Math.round(v)}`)
      .join(', ');

    return `${marks[i] || `${i + 1}番手`}: ${h.horseNumber}番 ${h.horseName} (総合:${h.totalScore.toFixed(1)}, 脚質:${h.runningStyle}, 父:${h.fatherName})
  主要ファクター: [${topFactors}]`;
  }).join('\n');

  return `あなたは日本の競馬専門アナリストです。以下の統計分析データに基づき、競馬ファン向けの解説を生成してください。

## レース情報
- レース名: ${prediction.raceName}
- 競馬場: ${ctx.racecourseName} ${ctx.trackType}${ctx.distance}m
- 馬場状態: ${ctx.trackCondition}
- グレード: ${ctx.grade || '一般'}
- AI信頼度: ${prediction.confidence}%

## 統計エンジンの予想結果

${horsesText}

展開分析(元データ): ${prediction.analysis.paceAnalysis}
馬場バイアス(元データ): ${prediction.analysis.trackBias}

## 出力指示

以下のJSONスキーマに厳密に従って出力してください。JSON以外は出力しないでください。

{
  "summary": "レース全体の見どころと予想の核心を述べる2〜4段落のサマリー（段落間は改行\\nで区切る）",
  "picks": [
    { "horseNumber": 馬番号, "reasons": ["理由1（40〜80字）", "理由2", "理由3"] }
  ],
  "trackBias": "馬場・コース特性の解説（100〜200字）",
  "paceAnalysis": "展開予想の解説（100〜200字）",
  "keyFactors": ["注目ポイント1", "注目ポイント2", "注目ポイント3"],
  "riskFactors": ["リスク要因1", "リスク要因2"],
  "betReasonings": [
    { "type": "馬券種（単勝/複勝/馬連/ワイド/三連複/馬単/三連単）", "reasoning": "推奨理由（60〜120字）" }
  ]
}

重要な制約:
- picksは上位6頭分を出力（上記の順位を維持すること）
- スコア・馬番・馬名は絶対に変更しないこと
- 統計データに基づく事実のみ述べる（根拠のない憶測は避ける）
- 各馬の理由は、なぜそのファクタースコアが高い/低いのかを具体的に説明する
- 複数のファクターを繋げて「なぜこの馬が有力なのか」のストーリーを作る
- 自然な競馬評論の文体で書く（「〜と見る」「〜に注目」「〜が鍵を握る」等）`;
}

// ==================== Merge enhanced output ====================

function mergeEnhancedOutput(
  original: Prediction,
  enhanced: GeminiEnhancedOutput,
): Prediction {
  const enhancedPicksMap = new Map(
    (enhanced.picks ?? []).map(p => [p.horseNumber, p.reasons])
  );

  const mergedPicks: PredictionPick[] = original.topPicks.map(pick => ({
    ...pick,
    reasons: enhancedPicksMap.get(pick.horseNumber) ?? pick.reasons,
  }));

  // analysis の隠しフィールド (horseScores) を保持
  const mergedAnalysis: RaceAnalysis = {
    ...original.analysis,
    trackBias: enhanced.trackBias || original.analysis.trackBias,
    paceAnalysis: enhanced.paceAnalysis || original.analysis.paceAnalysis,
    keyFactors: enhanced.keyFactors?.length ? enhanced.keyFactors : original.analysis.keyFactors,
    riskFactors: enhanced.riskFactors?.length ? enhanced.riskFactors : original.analysis.riskFactors,
  };

  const enhancedBetsMap = new Map(
    (enhanced.betReasonings ?? []).map(b => [b.type, b.reasoning])
  );

  const mergedBets: RecommendedBet[] = original.recommendedBets.map(bet => ({
    ...bet,
    reasoning: enhancedBetsMap.get(bet.type) ?? bet.reasoning,
  }));

  return {
    ...original,
    summary: enhanced.summary || original.summary,
    topPicks: mergedPicks,
    analysis: mergedAnalysis,
    recommendedBets: mergedBets,
  };
}

// ==================== Main export ====================

export async function enhancePredictionWithGemini(
  prediction: Prediction,
  ctx: GeminiRaceContext,
): Promise<Prediction> {
  const client = getGenAI();
  if (!client) return prediction;

  try {
    const prompt = buildPrompt(prediction, ctx);

    const response = await client.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        temperature: 0.7,
        maxOutputTokens: 1500,
      },
    });

    const rawText = response.text ?? '';
    const enhanced = JSON.parse(rawText) as GeminiEnhancedOutput;

    return mergeEnhancedOutput(prediction, enhanced);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack?.split('\n').slice(0, 3).join(' ') : '';
    console.error(`[gemini-enhancer] FAILED: ${msg} | ${stack}`);
    return prediction;
  }
}
