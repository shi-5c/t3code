import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Digest from "effect/crypto/Digest";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export function supportsNativeTitleProcess(input: {
  configured: string;
  command: string;
  args: ReadonlyArray<unknown>;
  shell?: boolean | string | undefined;
}) {
  const normalize = (value: string) => value.replaceAll("/", "\\").toLowerCase();
  const configured = normalize(input.configured);
  return (
    /^[a-z]:\\.*\\codex\.exe$/.test(configured) &&
    !input.shell &&
    normalize(input.command) === configured &&
    input.args.length === 1 &&
    input.args[0] === "app-server"
  );
}

/** Windows recovery only: PID absence is evidence on the same physical host. */
export const readNativeTitleHostKey = Effect.gen(function* () {
  if ((yield* HostProcess.Platform) !== "win32") return undefined;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const text = yield* spawner
    .string(
      ChildProcess.make("reg.exe", [
        "query",
        "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
        "/v",
        "MachineGuid",
        "/reg:64",
      ]),
    )
    .pipe(
      Effect.timeout(3_000),
      Effect.orElseSucceed(() => ""),
    );
  const value = text.match(/MachineGuid\s+REG_SZ\s+([a-f0-9-]{36})/i)?.[1];
  if (!value) return undefined;
  const digest = yield* Digest.Digest;
  return yield* digest.digestHex(
    Digest.sha256,
    new TextEncoder().encode(`t3-native-title:${value.toLowerCase()}`),
  );
}).pipe(Effect.provide(Digest.layerWebCrypto));

export function nativeTitleProcessHasExited(
  currentHostKey: string | undefined,
  previous: { readonly pid: number; readonly hostKey: string },
  probe: (pid: number) => void = (pid) => {
    process.kill(pid, 0);
  },
): boolean {
  if (
    !currentHostKey ||
    previous.hostKey !== currentHostKey ||
    !Number.isSafeInteger(previous.pid) ||
    previous.pid <= 0
  )
    return false;
  try {
    probe(previous.pid);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
}
