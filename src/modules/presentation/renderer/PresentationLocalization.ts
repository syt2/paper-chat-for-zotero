export interface PresentationRendererLabels {
  coverBrief: string;
  researchBrief: string;
  evidence: string;
  researchGap: string;
  whatThisChanges: string;
  coreConclusion: string;
  paperEstablishes: string;
  openQuestions: string;
  researchMilestones: string;
  sections: {
    problem: string;
    method: string;
    evidence: string;
    results: string;
    framework: string;
    progress: string;
    conclusion: string;
  };
}

const ENGLISH_LABELS: PresentationRendererLabels = {
  coverBrief: "PAPERCHAT · RESEARCH BRIEF",
  researchBrief: "Research brief",
  evidence: "EVIDENCE",
  researchGap: "RESEARCH GAP",
  whatThisChanges: "WHAT THIS CHANGES",
  coreConclusion: "CORE CONCLUSION",
  paperEstablishes: "THREE CORE FINDINGS",
  openQuestions: "TWO BOUNDARIES / OPEN QUESTIONS",
  researchMilestones: "NEXT RESEARCH STEPS",
  sections: {
    problem: "Problem",
    method: "Method",
    evidence: "Evidence",
    results: "Results",
    framework: "Framework",
    progress: "Progress",
    conclusion: "Conclusion",
  },
};

const SIMPLIFIED_CHINESE_LABELS: PresentationRendererLabels = {
  coverBrief: "PAPERCHAT · 研究简报",
  researchBrief: "研究简报",
  evidence: "证据",
  researchGap: "研究缺口",
  whatThisChanges: "这意味着什么",
  coreConclusion: "核心结论",
  paperEstablishes: "三项核心发现",
  openQuestions: "两项边界 / 开放问题",
  researchMilestones: "下一步研究路线",
  sections: {
    problem: "问题",
    method: "方法",
    evidence: "证据",
    results: "结果",
    framework: "框架",
    progress: "进展",
    conclusion: "结论",
  },
};

const TRADITIONAL_CHINESE_LABELS: PresentationRendererLabels = {
  coverBrief: "PAPERCHAT · 研究簡報",
  researchBrief: "研究簡報",
  evidence: "證據",
  researchGap: "研究缺口",
  whatThisChanges: "這意味著什麼",
  coreConclusion: "核心結論",
  paperEstablishes: "三項核心發現",
  openQuestions: "兩項邊界 / 開放問題",
  researchMilestones: "下一步研究路線",
  sections: {
    problem: "問題",
    method: "方法",
    evidence: "證據",
    results: "結果",
    framework: "架構",
    progress: "進展",
    conclusion: "結論",
  },
};

export function resolvePresentationRendererLabels(
  language?: string,
): PresentationRendererLabels {
  const locale = String(language || "en-US")
    .trim()
    .replace(/_/g, "-")
    .toLowerCase();
  if (/^zh-(?:tw|hk|mo)(?:-|$)/.test(locale)) {
    return TRADITIONAL_CHINESE_LABELS;
  }
  if (locale === "zh" || locale.startsWith("zh-")) {
    return SIMPLIFIED_CHINESE_LABELS;
  }
  return ENGLISH_LABELS;
}

export function isOpenQuestionsLabel(
  value: string | undefined,
  labels: PresentationRendererLabels,
): boolean {
  const normalized = value?.trim().toLocaleUpperCase();
  return (
    normalized === ENGLISH_LABELS.openQuestions ||
    normalized === labels.openQuestions.toLocaleUpperCase()
  );
}
