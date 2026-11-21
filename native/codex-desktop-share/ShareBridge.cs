using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.WebSockets;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

internal static class ShareBridge
{
    private const string Issuer = "t3-desktop-share";
    private const int MaximumFrameBytes = 32 * 1024 * 1024;
    private static readonly Encoding Utf8 = new UTF8Encoding(false, true);
    private static readonly string Endpoint = Path.ChangeExtension(Assembly.GetEntryAssembly().Location, ".endpoint");

    internal static bool IsDesktopOwner(string[] args)
    {
        if (args.Length < 6 || args[0] != "-c" || args[1] != "features.code_mode_host=true" ||
            args[2] != "app-server" || args[3] != "--analytics-default-enabled" ||
            args[4] != "-c" || args[5] != "features.prefer_mxc=true")
            return false;

        int index = 6;
        if (index + 1 < args.Length && args[index] == "-c" && IsAppToolsConfig(args[index + 1]))
            index += 2;
        for (; index < args.Length; index += 4)
        {
            if (index + 3 >= args.Length ||
                (args[index] != "--plugin-mcp-launch-cwd" && args[index] != "--mcp-launch-cwd"))
                return false;
            for (int value = index + 1; value <= index + 3; value++)
                if (String.IsNullOrEmpty(args[value]) || args[value].StartsWith("-", StringComparison.Ordinal))
                    return false;
        }
        return true;
    }

    private static bool IsAppToolsConfig(string value)
    {
        return Regex.IsMatch(value,
            "^plugins\\.(codex-app-tools@openai-bundled|\"codex-app-tools@openai-bundled\"|'codex-app-tools@openai-bundled')\\.mcp_servers\\.codex_app\\.enabled=(true|false)$");
    }

    internal static int RunOwner(string[] arguments, Action<Process> attach)
    {
        using (new FileStream(Endpoint + ".lock", FileMode.OpenOrCreate, FileAccess.ReadWrite,
            FileShare.None, 1, FileOptions.DeleteOnClose))
        {
            File.Delete(Endpoint);
            var generation = Guid.NewGuid().ToString("N");
            var secret = NewSecret();
            var secretPath = Endpoint + "." + generation + ".key";
            var pending = Endpoint + "." + generation + ".pending";
            try
            {
                WritePrivate(secretPath, Utf8.GetBytes(secret));
                var command = new StringBuilder();
                foreach (var argument in arguments)
                    AddArgument(command, argument);
                foreach (var argument in new[] { "--listen", "ws://127.0.0.1:0", "--ws-auth",
                    "signed-bearer-token", "--ws-shared-secret-file", secretPath, "--ws-issuer",
                    Issuer, "--ws-audience", generation })
                    AddArgument(command, argument);

                var start = new ProcessStartInfo(PinnedCli.Path, command.ToString()) {
                    UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true,
                    RedirectStandardOutput = true, RedirectStandardError = true
                };
                using (var child = new Process { StartInfo = start, EnableRaisingEvents = true })
                {
                    var listening = new TaskCompletionSource<int>();
                    child.ErrorDataReceived += (sender, record) => {
                        if (record.Data == null)
                            return;
                        var match = Regex.Match(record.Data, @"listening on: ws://127\.0\.0\.1:(\d+)\s*$");
                        if (match.Success)
                            listening.TrySetResult(Int32.Parse(match.Groups[1].Value));
                    };
                    child.OutputDataReceived += (sender, record) => { };
                    child.Exited += (sender, record) => listening.TrySetException(new IOException("App-server exited."));
                    if (!child.Start())
                        throw new IOException("App-server did not start.");
                    try
                    {
                        attach(child);
                        child.BeginErrorReadLine();
                        child.BeginOutputReadLine();
                        child.StandardInput.Close();
                        if (!listening.Task.Wait(TimeSpan.FromSeconds(25)))
                            throw new IOException("App-server did not publish a loopback listener.");
                        var port = listening.Task.Result;
                        using (var socket = Connect(port, Token(secret, generation, "desktop")))
                        {
                            var contents = String.Join("\n", port.ToString(), generation,
                                child.Id.ToString(), child.StartTime.ToUniversalTime().Ticks.ToString(),
                                Convert.ToBase64String(ProtectedData.Protect(Utf8.GetBytes(secret), null,
                                    DataProtectionScope.CurrentUser)));
                            WritePrivate(pending, Utf8.GetBytes(contents));
                            File.Move(pending, Endpoint);
                            File.Delete(secretPath);
                            return Relay(socket);
                        }
                    }
                    finally
                    {
                        if (!child.HasExited)
                            child.Kill();
                    }
                }
            }
            finally
            {
                File.Delete(Endpoint);
                File.Delete(pending);
                File.Delete(secretPath);
            }
        }
    }

    internal static int RunClient()
    {
        var info = new FileInfo(Endpoint);
        if (!info.Exists || info.Length > 8192 || (info.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new IOException("Shared Desktop is offline.");
        var parts = File.ReadAllLines(Endpoint, Utf8);
        Guid generation;
        int port, pid;
        long started;
        if (parts.Length != 5 || !Int32.TryParse(parts[0], out port) || port <= 0 || port > 65535 ||
            !Guid.TryParseExact(parts[1], "N", out generation) ||
            !Int32.TryParse(parts[2], out pid) || !Int64.TryParse(parts[3], out started))
            throw new IOException("Invalid shared Desktop endpoint.");
        using (var owner = Process.GetProcessById(pid))
            if (owner.HasExited || owner.StartTime.ToUniversalTime().Ticks != started ||
                !String.Equals(owner.MainModule.FileName, PinnedCli.Path, StringComparison.OrdinalIgnoreCase))
                throw new IOException("Shared Desktop generation has ended.");

        var secret = Utf8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(parts[4]), null,
            DataProtectionScope.CurrentUser));
        using (var socket = Connect(port, Token(secret, generation.ToString("N"), "t3")))
            return Relay(socket);
    }

    private static void AddArgument(StringBuilder command, string argument)
    {
        if (command.Length != 0)
            command.Append(' ');
        Forwarder.AppendArgument(command, argument);
    }

    private static void WritePrivate(string file, byte[] bytes)
    {
        var security = new FileSecurity();
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User,
            FileSystemRights.FullControl, AccessControlType.Allow));
        using (var stream = new FileStream(file, FileMode.CreateNew, FileSystemRights.FullControl,
            FileShare.None, 4096, FileOptions.None, security))
            stream.Write(bytes, 0, bytes.Length);
    }

    private static string NewSecret()
    {
        var bytes = new byte[32];
        using (var generator = RandomNumberGenerator.Create())
            generator.GetBytes(bytes);
        return Base64Url(bytes);
    }

    private static string Base64Url(byte[] bytes)
    {
        return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    private static string Token(string secret, string generation, string subject)
    {
        long expiration = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalSeconds + 300;
        var payload = String.Format("{{\"iss\":\"{0}\",\"aud\":\"{1}\",\"sub\":\"{2}\",\"exp\":{3}}}",
            Issuer, generation, subject, expiration);
        var unsigned = Base64Url(Utf8.GetBytes("{\"alg\":\"HS256\",\"typ\":\"JWT\"}")) + "." +
            Base64Url(Utf8.GetBytes(payload));
        using (var hash = new HMACSHA256(Utf8.GetBytes(secret)))
            return unsigned + "." + Base64Url(hash.ComputeHash(Utf8.GetBytes(unsigned)));
    }

    private static ClientWebSocket Connect(int port, string token)
    {
        var socket = new ClientWebSocket();
        try
        {
            socket.Options.Proxy = new WebProxy();
            socket.Options.SetRequestHeader("Authorization", "Bearer " + token);
            using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10)))
                socket.ConnectAsync(new Uri("ws://127.0.0.1:" + port), timeout.Token).GetAwaiter().GetResult();
            return socket;
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    private static int Relay(ClientWebSocket socket)
    {
        using (var cancel = new CancellationTokenSource())
        {
            var outgoing = Task.Run(async () => {
                using (var input = new StreamReader(Console.OpenStandardInput(), Utf8, false, 4096))
                {
                    string line;
                    while ((line = await input.ReadLineAsync().ConfigureAwait(false)) != null)
                    {
                        var frame = Utf8.GetBytes(line);
                        if (frame.Length > MaximumFrameBytes)
                            throw new IOException("Oversized Desktop message.");
                        await socket.SendAsync(new ArraySegment<byte>(frame), WebSocketMessageType.Text,
                            true, cancel.Token).ConfigureAwait(false);
                    }
                }
                return 0;
            });
            var incoming = Task.Run(async () => {
                var buffer = new byte[65536];
                var output = Console.OpenStandardOutput();
                var newline = new byte[] { 10 };
                using (var frame = new MemoryStream())
                {
                    while (true)
                    {
                        var received = await socket.ReceiveAsync(new ArraySegment<byte>(buffer),
                            cancel.Token).ConfigureAwait(false);
                        if (received.MessageType == WebSocketMessageType.Close)
                            return received.CloseStatus == WebSocketCloseStatus.NormalClosure ? 0 : 70;
                        if (received.MessageType != WebSocketMessageType.Text ||
                            frame.Length + received.Count > MaximumFrameBytes)
                            throw new IOException("Invalid app-server frame.");
                        frame.Write(buffer, 0, received.Count);
                        if (!received.EndOfMessage)
                            continue;
                        frame.WriteTo(output);
                        output.Write(newline, 0, 1);
                        output.Flush();
                        frame.SetLength(0);
                    }
                }
            });
            try { return Task.WhenAny(outgoing, incoming).GetAwaiter().GetResult().GetAwaiter().GetResult(); }
            finally { cancel.Cancel(); socket.Abort(); }
        }
    }
}
