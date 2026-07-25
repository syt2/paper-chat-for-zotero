import { assert } from "chai";
import {
  createAutoResolvedUserInputResponse,
  createCancelledUserInputResponse,
  normalizeRequestUserInputArgs,
} from "../src/modules/chat/user-input-request/RequestUserInputService.ts";

describe("request user input service", function () {
  it("normalizes a single-choice request", function () {
    const result = normalizeRequestUserInputArgs({
      reason: "ambiguous target",
      questions: [
        {
          id: "Confirm Path",
          header: "Confirm",
          question: "Which path should I take?",
          options: [
            {
              label: "Use current paper (Recommended)",
              description: "Continue with the current reader item.",
              recommended: true,
            },
            {
              label: "Search library",
              description: "Find a different paper first.",
            },
          ],
        },
      ],
    });

    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.equal(result.args.questions[0].id, "confirm_path");
    assert.equal(result.args.questions[0].type, "single_choice");
    assert.equal(
      result.args.questions[0].options?.[0].value,
      "use_current_paper_recommended",
    );
  });

  it("normalizes multiple form questions", function () {
    const result = normalizeRequestUserInputArgs({
      questions: [
        {
          id: "one",
          header: "One",
          question: "First?",
          options: [
            { label: "A", description: "A." },
            { label: "B", description: "B." },
          ],
        },
        {
          id: "two",
          header: "Two",
          question: "Describe the output.",
          type: "text",
          defaultValue: "Short note",
        },
        {
          id: "secret_token",
          header: "Token",
          question: "Paste the token.",
          type: "secret",
          required: false,
        },
      ],
    });

    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.lengthOf(result.args.questions, 3);
    assert.equal(result.args.questions[1].type, "text");
    assert.equal(result.args.questions[2].type, "secret");
  });

  it("rejects more than three questions", function () {
    const result = normalizeRequestUserInputArgs({
      questions: [
        {
          id: "one",
          header: "One",
          question: "First?",
          options: [
            { label: "A", description: "A." },
            { label: "B", description: "B." },
          ],
        },
        {
          id: "two",
          header: "Two",
          question: "Second?",
          type: "text",
        },
        {
          id: "three",
          header: "Three",
          question: "Third?",
          type: "text",
        },
        {
          id: "four",
          header: "Four",
          question: "Fourth?",
          type: "text",
        },
      ],
    });

    assert.isFalse(result.ok);
    if (result.ok) return;
    assert.include(result.issues.join(" "), "at most 3");
  });

  it("keeps ordinary choices at four but permits a bounded application list", function () {
    const requestWith = (count: number) => ({
      questions: [
        {
          id: "destination",
          header: "Destination",
          question: "Choose one.",
          options: Array.from({ length: count }, (_, index) => ({
            label: `Option ${index + 1}`,
            description: `Option ${index + 1}.`,
          })),
        },
      ],
    });

    assert.isTrue(normalizeRequestUserInputArgs(requestWith(4)).ok);
    assert.isFalse(normalizeRequestUserInputArgs(requestWith(5)).ok);
    assert.isTrue(
      normalizeRequestUserInputArgs(requestWith(100), { maxOptions: 100 }).ok,
    );
    assert.isFalse(
      normalizeRequestUserInputArgs(requestWith(101), { maxOptions: 100 }).ok,
    );
  });

  it("drops auto-resolution when a required question has no safe default", function () {
    const result = normalizeRequestUserInputArgs({
      autoResolutionMs: 60_000,
      questions: [
        {
          id: "choice",
          header: "Choice",
          question: "Choose one.",
          options: [
            { label: "A", description: "A." },
            { label: "B", description: "B." },
          ],
        },
      ],
    });

    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.isUndefined(result.args.autoResolutionMs);
    assert.include(result.warnings.join(" "), "autoResolutionMs was dropped");
  });

  it("drops secret defaults because they would persist sensitive text", function () {
    const result = normalizeRequestUserInputArgs({
      questions: [
        {
          id: "token",
          header: "Token",
          question: "Paste a token.",
          type: "secret",
          defaultValue: "sk-secret",
        },
      ],
    });

    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.isUndefined(result.args.questions[0].defaultValue);
    assert.include(result.warnings.join(" "), "defaultValue was dropped");
  });

  it("repairs secret input requests that include defaultValue and auto-resolution", function () {
    const result = normalizeRequestUserInputArgs({
      autoResolutionMs: 120_000,
      questions: [
        {
          id: "test_token",
          header: "Token",
          question: "Paste a test token.",
          type: "secret",
          defaultValue: "sk-test",
        },
      ],
    });

    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.equal(result.args.questions[0].id, "test_token");
    assert.equal(result.args.questions[0].type, "secret");
    assert.isUndefined(result.args.questions[0].defaultValue);
    assert.isUndefined(result.args.autoResolutionMs);
    assert.include(result.warnings.join(" "), "defaultValue was dropped");
    assert.include(result.warnings.join(" "), "autoResolutionMs was dropped");
  });

  it("validates multi-choice selection bounds", function () {
    const result = normalizeRequestUserInputArgs({
      questions: [
        {
          id: "pick",
          header: "Pick",
          question: "Pick options.",
          type: "multi_choice",
          minSelections: 3,
          maxSelections: 1,
          options: [
            { label: "A", description: "A." },
            { label: "B", description: "B." },
          ],
        },
      ],
    });

    assert.isFalse(result.ok);
    if (result.ok) return;
    assert.include(result.issues.join(" "), "minSelections");
  });

  it("creates structured cancel and auto-resolution responses", function () {
    const normalized = normalizeRequestUserInputArgs({
      autoResolutionMs: 60_000,
      questions: [
        {
          id: "choice",
          header: "Choice",
          question: "Choose one.",
          options: [
            { label: "A", description: "A.", recommended: true },
            { label: "B", description: "B." },
          ],
        },
      ],
    });

    assert.isTrue(normalized.ok);
    if (!normalized.ok) return;

    const cancelled = createCancelledUserInputResponse(normalized.args);
    assert.isTrue(cancelled.cancelled);
    assert.isTrue(cancelled.answers.choice.cancelled);

    const autoResolved = createAutoResolvedUserInputResponse(normalized.args);
    assert.isTrue(autoResolved.autoResolved);
    assert.deepEqual(autoResolved.answers.choice.answers, ["a"]);
  });
});
