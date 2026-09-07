import type { StreamToolCallingResult } from "../../types/chat";
import { generateTimestampId } from "../../utils/common";
import {
  isIssuedPresentationLaunchAuthorization,
  type PresentationLaunchAuthorization,
} from "./PresentationLaunchAuthorization";

/** A user clicked resume: execute the saved task directly, without asking the
 * outer model to choose a new tool or opening the launch dialog again. */
export function createPresentationResumeRound(
  authorization?: PresentationLaunchAuthorization,
): StreamToolCallingResult | null {
  if (
    !isIssuedPresentationLaunchAuthorization(authorization) ||
    !authorization.checkpoint
  )
    return null;
  return {
    content: "",
    stopReason: "tool_calls",
    toolCalls: [
      {
        id: `ppt-resume-${generateTimestampId()}`,
        type: "function",
        function: {
          name: "presentation",
          arguments: JSON.stringify(authorization.checkpoint.args),
        },
      },
    ],
  };
}
