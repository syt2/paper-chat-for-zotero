/**
 * AISummary Default Templates - 默认模板定义
 */

import type { AISummaryTemplate } from "../../types/ai-summary";

export const DEFAULT_TEMPLATES: AISummaryTemplate[] = [
  {
    id: "summary-brief",
    name: "Brief Summary",
    prompt: `Please provide a brief summary of this academic paper in 2-3 paragraphs.

Title: {{title}}
Authors: {{authors}}
Year: {{year}}

{{#if abstract}}
Abstract: {{abstract}}
{{/if}}

{{#if pdfContent}}
Full Text (excerpt):
{{pdfContent}}
{{/if}}

Focus on:
1. The main research question or objective
2. The methodology used
3. Key findings and contributions

Write in a clear, academic style.`,
    systemPrompt:
      "You are an expert academic research assistant. Provide concise, accurate summaries of research papers.",
    noteTitle: "AI Summary: {{title}}",
    tags: ["ai-processed", "summary"],
    maxTokens: 1000,
  },
  {
    id: "key-findings",
    name: "Key Findings",
    prompt: `Extract the key findings from this paper in bullet points.

Title: {{title}}
Authors: {{authors}}

{{#if abstract}}
Abstract: {{abstract}}
{{/if}}

{{#if pdfContent}}
Full Text (excerpt):
{{pdfContent}}
{{/if}}

Please list:
- 5-7 most important findings or contributions
- Each point should be 1-2 sentences
- Focus on empirical results and theoretical contributions`,
    systemPrompt: "You are a research analyst. Extract and organize key findings from academic papers.",
    noteTitle: "Key Findings: {{title}}",
    tags: ["ai-processed", "key-findings"],
    maxTokens: 800,
  },
  {
    id: "methodology-analysis",
    name: "Methodology Analysis",
    prompt: `Analyze the methodology used in this paper.

Title: {{title}}
Authors: {{authors}}

{{#if abstract}}
Abstract: {{abstract}}
{{/if}}

{{#if pdfContent}}
Full Text (excerpt):
{{pdfContent}}
{{/if}}

Please describe:
1. Research design and approach
2. Data collection methods
3. Analysis techniques
4. Strengths and limitations of the methodology`,
    systemPrompt: "You are a methodologist reviewing research papers. Provide detailed methodological analysis.",
    noteTitle: "Methodology: {{title}}",
    tags: ["ai-processed", "methodology"],
    maxTokens: 1200,
  },
  {
    id: "literature-note",
    name: "Literature Note",
    prompt: `Create a comprehensive literature note for this paper.

Title: {{title}}
Authors: {{authors}}
Year: {{year}}
DOI: {{doi}}

{{#if abstract}}
Abstract: {{abstract}}
{{/if}}

{{#if pdfContent}}
Full Text (excerpt):
{{pdfContent}}
{{/if}}

Please include:
## Summary
Brief overview of the paper

## Research Question
What problem does this paper address?

## Methodology
How did the authors approach the problem?

## Key Findings
Main results and contributions

## Relevance
Why is this paper important?

## Citation
How to cite this work`,
    systemPrompt: "You are a researcher creating detailed literature notes for academic papers.",
    noteTitle: "Literature Note: {{title}}",
    tags: ["ai-processed", "literature-note"],
    maxTokens: 1500,
  },
];

/**
 * Get template by ID
 */
export function getTemplateById(templateId: string): AISummaryTemplate | undefined {
  return DEFAULT_TEMPLATES.find((t) => t.id === templateId);
}

/**
 * Get all available templates
 */
export function getAllTemplates(): AISummaryTemplate[] {
  return DEFAULT_TEMPLATES;
}
