import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

const T3CODE_CODEX_LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";

// The fixed Desktop identity cannot safely route a new native chat through
// unverified per-process account/profile overrides. Existing followers still work.
export const sharedCodexNativeOverrideError = (
  launchArgs: string,
  environment: NodeJS.ProcessEnv,
): string | null => {
  if (resolveCodexLaunchArgs(launchArgs, environment))
    return "Codex Desktop Share cannot create a native conversation with custom launch arguments. Use a separate Codex provider for this configuration, or connect an existing Desktop conversation.";
  if (
    Object.entries(environment).some(
      ([name, value]) =>
        value?.trim() && /^(OPENAI_|AZURE_OPENAI_|CODEX_API_KEY$|CHATGPT_BASE_URL$)/i.test(name),
    )
  )
    return "Codex Desktop Share cannot verify this process's account or endpoint overrides. Use a separate Codex provider, or connect an existing Desktop conversation.";
  return null;
};

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
) => environment[T3CODE_CODEX_LAUNCH_ARGS_ENV]?.trim() || launchArgs?.trim() || "";

const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> => tokenizeCliArgs(launchArgs);

export const codexAppServerArgs = (launchArgs?: string) => [
  "app-server",
  ...codexLaunchArgv(launchArgs),
];

export const codexExecLaunchArgs = (launchArgs?: string) => {
  const args = codexLaunchArgv(launchArgs);
  const execArgs: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--strict-config" || arg.startsWith("--config=") || arg.startsWith("-c=")) {
      execArgs.push(arg);
    } else if (arg === "--config" || arg === "-c" || arg === "--enable" || arg === "--disable") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        execArgs.push(arg, value);
        index++;
      }
    } else if (arg.startsWith("--enable=") || arg.startsWith("--disable=")) {
      execArgs.push(arg);
    }
  }

  return execArgs;
};
