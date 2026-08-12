import { getDataPath } from "../../../utils/common";
import { BUILT_IN_PAPER_SKILL_MARKDOWN } from "./BuiltInPaperSkills";

const LOCAL_SKILLS_ROOT = "skills";
const SKILL_FILE = "SKILL.md";
const MAX_SKILLS = 2;
const CACHE_TTL_MS = 30_000;
const BUILT_IN_SKILL_PATH_PREFIX = "builtin://paper-chat/skills";

export interface PaperChatSkill {
  slug: string;
  name: string;
  description: string;
  triggers: string[];
  body: string;
  path: string;
}

export interface SelectedPaperChatSkill {
  slug: string;
  name: string;
  description: string;
  prompt: string;
  score: number;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function safeSlugFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const lastPart = normalized.split("/").pop() || "skill";
  return (
    lastPart
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "skill"
  );
}

function splitFrontmatter(raw: string): {
  frontmatter: string;
  body: string;
} {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return {
      frontmatter: "",
      body: normalized.trim(),
    };
  }
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) {
    return {
      frontmatter: "",
      body: normalized.trim(),
    };
  }
  return {
    frontmatter: normalized.slice(4, end).trim(),
    body: normalized.slice(end + 4).trim(),
  };
}

function parseFrontmatter(frontmatter: string): {
  name?: string;
  description?: string;
  triggers: string[];
} {
  const triggers: string[] = [];
  let currentListKey: "triggers" | null = null;
  let name: string | undefined;
  let description: string | undefined;

  for (const rawLine of frontmatter.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (currentListKey && line.startsWith("-")) {
      const value = line.replace(/^-\s*/, "").trim();
      if (value) {
        triggers.push(value);
      }
      continue;
    }
    currentListKey = null;

    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }
    const key = match[1];
    const value = match[2].trim().replace(/^["']|["']$/g, "");
    if (key === "name") {
      name = value;
    } else if (key === "description") {
      description = value;
    } else if (key === "triggers") {
      if (value.startsWith("[") && value.endsWith("]")) {
        for (const entry of value.slice(1, -1).split(",")) {
          const trigger = entry.trim().replace(/^["']|["']$/g, "");
          if (trigger) {
            triggers.push(trigger);
          }
        }
      } else if (value) {
        triggers.push(value);
      } else {
        currentListKey = "triggers";
      }
    }
  }

  return {
    name,
    description,
    triggers,
  };
}

export function parseSkillMarkdown(
  slug: string,
  path: string,
  raw: string,
): PaperChatSkill | null {
  const { frontmatter, body } = splitFrontmatter(raw);
  if (!body) {
    return null;
  }
  const meta = parseFrontmatter(frontmatter);
  const inferredTitle = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const name = meta.name || inferredTitle || slug;
  const description = meta.description || "";
  return {
    slug,
    name: name.slice(0, 80),
    description: description.slice(0, 240),
    triggers: meta.triggers.map((trigger) => trigger.slice(0, 120)),
    body,
    path,
  };
}

function loadBuiltInSkills(): PaperChatSkill[] {
  const skills: PaperChatSkill[] = [];
  for (const [slug, raw] of Object.entries(BUILT_IN_PAPER_SKILL_MARKDOWN)) {
    const skill = parseSkillMarkdown(
      slug,
      `${BUILT_IN_SKILL_PATH_PREFIX}/${slug}/${SKILL_FILE}`,
      raw,
    );
    if (skill) {
      skills.push(skill);
    }
  }
  return skills;
}

function scoreSkill(skill: PaperChatSkill, query: string): number {
  const normalizedQuery = normalizeWhitespace(query).toLowerCase();
  if (!normalizedQuery) {
    return 0;
  }

  let score = 0;
  for (const trigger of skill.triggers) {
    const normalizedTrigger = normalizeWhitespace(trigger).toLowerCase();
    if (normalizedTrigger && normalizedQuery.includes(normalizedTrigger)) {
      score += 12;
    }
  }

  const fields = [
    { text: skill.name, weight: 5 },
    { text: skill.description, weight: 3 },
    { text: skill.triggers.join(" "), weight: 6 },
    { text: skill.body.slice(0, 800), weight: 1 },
  ];

  for (const field of fields) {
    const text = field.text.toLowerCase();
    if (!text) {
      continue;
    }
    for (const token of normalizedQuery.split(/\s+/).filter(Boolean)) {
      if (token.length < 2) {
        continue;
      }
      if (fieldMatchesToken(text, token)) {
        score += field.weight;
      }
    }
  }

  return score;
}

function fieldMatchesToken(text: string, token: string): boolean {
  if (/[\u3400-\u9fff\uf900-\ufaff]/.test(token)) {
    return text.includes(token);
  }
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text);
}

function formatSelectedSkill(skill: PaperChatSkill): SelectedPaperChatSkill {
  const parts = [
    `Skill: ${skill.name}`,
    skill.description ? `Description: ${skill.description}` : "",
    "Instructions:",
    skill.body,
  ].filter(Boolean);
  return {
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    prompt: parts.join("\n"),
    score: 0,
  };
}

export class SkillRegistry {
  private cachedSkills: PaperChatSkill[] = [];
  private cacheUpdatedAt = 0;

  async listSkills(force: boolean = false): Promise<PaperChatSkill[]> {
    const now = Date.now();
    if (!force && now - this.cacheUpdatedAt < CACHE_TTL_MS) {
      return this.cachedSkills;
    }

    const skillsBySlug = new Map<string, PaperChatSkill>();
    for (const skill of loadBuiltInSkills()) {
      skillsBySlug.set(skill.slug, skill);
    }

    for (const skill of await this.loadLocalSkills()) {
      skillsBySlug.set(skill.slug, skill);
    }

    this.cachedSkills = [...skillsBySlug.values()].sort((left, right) =>
      left.slug.localeCompare(right.slug),
    );
    this.cacheUpdatedAt = now;
    return this.cachedSkills;
  }

  async selectSkills(query: string): Promise<SelectedPaperChatSkill[]> {
    const skills = await this.listSkills();
    return skills
      .map((skill) => ({
        skill,
        score: scoreSkill(skill, query),
      }))
      .filter((entry) => entry.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.skill.slug.localeCompare(right.skill.slug),
      )
      .slice(0, MAX_SKILLS)
      .map((entry) => ({
        ...formatSelectedSkill(entry.skill),
        score: entry.score,
      }));
  }

  private async loadLocalSkills(): Promise<PaperChatSkill[]> {
    if (
      typeof Zotero === "undefined" ||
      typeof PathUtils === "undefined" ||
      typeof IOUtils === "undefined"
    ) {
      return [];
    }

    const root = getDataPath(LOCAL_SKILLS_ROOT);
    if (!(await IOUtils.exists(root))) {
      return [];
    }

    const children = await IOUtils.getChildren(root);
    const skills: PaperChatSkill[] = [];
    for (const child of children) {
      const slug = safeSlugFromPath(child);
      const skillPath = PathUtils.join(child, SKILL_FILE);
      try {
        if (!(await IOUtils.exists(skillPath))) {
          continue;
        }
        const raw = await IOUtils.readUTF8(skillPath);
        const skill = parseSkillMarkdown(slug, skillPath, raw);
        if (skill) {
          skills.push(skill);
        }
      } catch (error) {
        try {
          ztoolkit.log("[SkillRegistry] Failed to load skill:", child, error);
        } catch {
          // Logging must not make a malformed local skill break chat startup.
        }
      }
    }
    return skills;
  }
}

let skillRegistry: SkillRegistry | null = null;

export function getSkillRegistry(): SkillRegistry {
  if (!skillRegistry) {
    skillRegistry = new SkillRegistry();
  }
  return skillRegistry;
}

export function resetSkillRegistryForTests(): void {
  skillRegistry = null;
}
