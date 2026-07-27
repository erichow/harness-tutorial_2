import type {
  InteractivePermissionHandler,
  NormalizedPermissionRequest,
} from "../security/permissions.js";
import type { InputController } from "./input.js";
import type { TerminalRenderer } from "./renderer.js";

export function createTerminalPermissionHandler(
  input: InputController,
  renderer: TerminalRenderer,
): InteractivePermissionHandler {
  return async (
    request: NormalizedPermissionRequest,
    reason: string,
    signal: AbortSignal,
  ) => {
    const prompt = renderer.beginPermission(request, reason);
    let outcome: "allow_once" | "allow_session" | "deny" | "cancelled" = "cancelled";
    try {
      while (true) {
        const answer = (await input.readLine(prompt, { signal }))?.trim().toLowerCase();
        if (answer === null || answer === undefined || answer === "n" || answer === "no") {
          outcome = "deny";
          return "deny";
        }
        if (answer === "y" || answer === "yes") {
          outcome = "allow_once";
          return "allow_once";
        }
        if (answer === "a" || answer === "session") {
          outcome = "allow_session";
          return "allow_session";
        }
        renderer.permissionNotice("Please enter y, a, or n.");
      }
    } finally {
      renderer.endPermission(outcome);
    }
  };
}
