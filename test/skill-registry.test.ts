import { assert } from "chai";
import {
  SkillRegistry,
  parseSkillMarkdown,
  resetSkillRegistryForTests,
} from "../src/modules/chat/skills/index.ts";
import { generateAgentRuntimeContextPrompt } from "../src/modules/chat/pdf-tools/promptGenerator.ts";

function installSkillFileSystem(skills: Record<string, string>) {
  const originalZotero = (globalThis as any).Zotero;
  const originalPathUtils = (globalThis as any).PathUtils;
  const originalIOUtils = (globalThis as any).IOUtils;
  const originalZtoolkit = (globalThis as any).ztoolkit;
  const root = "/tmp/zotero/paper-chat/skills";
  const files = new Map<string, string>();
  for (const [slug, content] of Object.entries(skills)) {
    files.set(`${root}/${slug}/SKILL.md`, content);
  }

  (globalThis as any).Zotero = {
    DataDirectory: {
      dir: "/tmp/zotero",
    },
  };
  (globalThis as any).PathUtils = {
    join: (...parts: string[]) => parts.join("/").replace(/\/+/g, "/"),
  };
  (globalThis as any).IOUtils = {
    exists: async (path: string) =>
      path === root ||
      [...files.keys()].some((filePath) => filePath.startsWith(`${path}/`)) ||
      files.has(path),
    getChildren: async (path: string) =>
      path === root ? Object.keys(skills).map((slug) => `${root}/${slug}`) : [],
    readUTF8: async (path: string) => {
      if (!files.has(path)) {
        throw new Error(`missing file: ${path}`);
      }
      return files.get(path) || "";
    },
  };
  (globalThis as any).ztoolkit = {
    log: () => undefined,
  };

  return () => {
    (globalThis as any).Zotero = originalZotero;
    (globalThis as any).PathUtils = originalPathUtils;
    (globalThis as any).IOUtils = originalIOUtils;
    (globalThis as any).ztoolkit = originalZtoolkit;
    resetSkillRegistryForTests();
  };
}

describe("paper workflow skills", function () {
  it("ships built-in paper reading skills by default", async function () {
    const registry = new SkillRegistry();
    const skills = await registry.listSkills(true);
    const slugs = skills.map((skill) => skill.slug);

    assert.include(slugs, "paper-deep-reading");
    assert.include(slugs, "related-work-map");
    assert.include(slugs, "claim-evidence-audit");
    assert.include(slugs, "method-reproduction-plan");
    assert.include(slugs, "reviewer-style-critique");

    const selected = await registry.selectSkills("帮我精读并总结这篇论文");
    assert.isAtLeast(selected.length, 1);
    assert.equal(selected[0].slug, "paper-deep-reading");
  });

  it("parses frontmatter and markdown fallback", function () {
    const skill = parseSkillMarkdown(
      "related-work-map",
      "/skills/related-work-map/SKILL.md",
      [
        "---",
        "name: Related Work Map",
        "description: Compare adjacent papers.",
        "triggers:",
        "  - related work",
        "  - literature review",
        "---",
        "",
        "Read the claim, then compare the closest papers.",
      ].join("\n"),
    );

    assert.equal(skill?.name, "Related Work Map");
    assert.equal(skill?.description, "Compare adjacent papers.");
    assert.deepEqual(skill?.triggers, ["related work", "literature review"]);
    assert.include(skill?.body || "", "Read the claim");
  });

  it("selects matching local skills deterministically", async function () {
    const restore = installSkillFileSystem({
      "related-work-map": [
        "---",
        "name: Related Work Map",
        "description: Compare related papers.",
        "triggers: [related work, literature review]",
        "---",
        "Find neighboring papers and compare claims.",
      ].join("\n"),
      "reviewer-response": [
        "---",
        "name: Reviewer Response",
        "description: Draft responses to reviewer comments.",
        "triggers: [reviewer response]",
        "---",
        "Draft a response letter.",
      ].join("\n"),
    });

    try {
      const registry = new SkillRegistry();
      const selected = await registry.selectSkills(
        "Please draft a reviewer response letter.",
      );
      assert.isAtLeast(selected.length, 1);
      assert.equal(selected[0].slug, "reviewer-response");
      assert.include(selected[0].prompt, "Draft a response letter");
    } finally {
      restore();
    }
  });

  it("lets a local skill override a built-in skill with the same slug", async function () {
    const restore = installSkillFileSystem({
      "paper-deep-reading": [
        "---",
        "name: My Deep Reading",
        "description: User customized deep reading workflow.",
        "triggers: [deep reading, 精读]",
        "---",
        "Use my local checklist.",
      ].join("\n"),
    });

    try {
      const registry = new SkillRegistry();
      const skills = await registry.listSkills(true);
      const deepReading = skills.find(
        (skill) => skill.slug === "paper-deep-reading",
      );

      assert.equal(deepReading?.name, "My Deep Reading");
      assert.include(deepReading?.body || "", "Use my local checklist");
      assert.notInclude(deepReading?.path || "", "builtin://");
    } finally {
      restore();
    }
  });

  it("injects selected skills as bounded workflow guidance", function () {
    const prompt = generateAgentRuntimeContextPrompt(undefined, {
      selectedSkills: [
        {
          slug: "paper-deep-reading",
          name: "Paper Deep Reading",
          description: "Read one paper deeply.",
          prompt:
            "Skill: Paper Deep Reading\nInstructions:\nTrace claims to evidence.",
        },
      ],
    });

    assert.include(prompt, "ACTIVE PAPER WORKFLOW SKILLS");
    assert.include(prompt, "Paper Deep Reading");
    assert.include(prompt, "do not grant extra tool permissions");
    assert.include(prompt, "Trace claims to evidence");
  });
});
