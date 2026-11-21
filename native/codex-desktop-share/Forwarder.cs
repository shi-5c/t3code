using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

internal static class Forwarder
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, Width, Height, Columns, Rows, Fill, Flags;
        public ushort ShowWindow, ReservedSize;
        public IntPtr ReservedBytes, Input, Output, Error;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo
    {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobLimits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref JobLimits limits, int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
        string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
        bool inheritHandles, uint flags, IntPtr environment, string workingDirectory,
        ref StartupInfo startup, out ProcessInfo process);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int id);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetConsoleWindow();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint timeout);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll")]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr process, int informationClass,
        [Out] IntPtr[] information, int size, out int returned);

    private static IntPtr InheritableStandardHandle(int id)
    {
        var handle = GetStdHandle(id);
        if (handle != IntPtr.Zero && handle != new IntPtr(-1) && !SetHandleInformation(handle, 1, 1))
            throw new Win32Exception();
        return handle;
    }

    internal static void AppendArgument(StringBuilder commandLine, string value)
    {
        commandLine.Append('"');
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            commandLine.Append('\\', character == '"' ? backslashes * 2 + 1 : backslashes);
            commandLine.Append(character);
            backslashes = 0;
        }
        commandLine.Append('\\', backslashes * 2);
        commandLine.Append('"');
    }

    private static bool IsDesktopParent()
    {
        using (var self = Process.GetCurrentProcess())
        {
            var basic = new IntPtr[6];
            int returned;
            if (NtQueryInformationProcess(self.Handle, 0, basic, basic.Length * IntPtr.Size, out returned) != 0)
                return false;
            try
            {
                using (var parent = Process.GetProcessById(basic[5].ToInt32()))
                    return parent.SessionId == self.SessionId && parent.StartTime <= self.StartTime &&
                        String.Equals(parent.MainModule.FileName, PinnedCli.DesktopPath, StringComparison.OrdinalIgnoreCase);
            }
            catch (ArgumentException) { return false; }
            catch (InvalidOperationException) { return false; }
            catch (Win32Exception) { return false; }
        }
    }

    private static int Main(string[] arguments)
    {
        if (PinnedCli.Share && arguments.Length == 1 && arguments[0] == "--t3-desktop-share-connect")
            return RunShared(() => ShareBridge.RunClient());
        if (PinnedCli.Share && ShareBridge.IsDesktopOwner(arguments) && IsDesktopParent())
            return RunShared(() => {
                var sharedJob = CreateJobObject(IntPtr.Zero, null);
                try
                {
                    var limits = new JobLimits { Flags = 0x2000 };
                    if (sharedJob == IntPtr.Zero ||
                        !SetInformationJobObject(sharedJob, 9, ref limits, Marshal.SizeOf(limits)))
                        throw new Win32Exception();
                    return ShareBridge.RunOwner(arguments, process => {
                        if (!AssignProcessToJobObject(sharedJob, process.Handle))
                            throw new Win32Exception();
                    });
                }
                finally { if (sharedJob != IntPtr.Zero) CloseHandle(sharedJob); }
            });

        var commandLine = new StringBuilder();
        AppendArgument(commandLine, PinnedCli.Path);
        foreach (string argument in arguments)
        {
            commandLine.Append(' ');
            AppendArgument(commandLine, argument);
        }

        IntPtr job = IntPtr.Zero;
        var child = new ProcessInfo();
        bool resumed = false;
        try
        {
            // Keep the stock CLI and its descendants tied to the wrapper's lifetime.
            job = CreateJobObject(IntPtr.Zero, null);
            var limits = new JobLimits { Flags = 0x2000 };
            if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits)))
                throw new Win32Exception();
            var startup = new StartupInfo
            {
                Size = Marshal.SizeOf(typeof(StartupInfo)),
                Flags = 0x100,
                Input = InheritableStandardHandle(-10),
                Output = InheritableStandardHandle(-11),
                Error = InheritableStandardHandle(-12)
            };
            uint flags = 0x00000004; // CREATE_SUSPENDED
            if (GetConsoleWindow() == IntPtr.Zero) flags |= 0x08000000;
            if (!CreateProcessW(PinnedCli.Path, commandLine, IntPtr.Zero, IntPtr.Zero, true, flags,
                IntPtr.Zero, null, ref startup, out child))
                throw new Win32Exception();
            if (!AssignProcessToJobObject(job, child.Process) || ResumeThread(child.Thread) == uint.MaxValue)
                throw new Win32Exception();
            resumed = true;
            uint exitCode;
            if (WaitForSingleObject(child.Process, uint.MaxValue) != 0 || !GetExitCodeProcess(child.Process, out exitCode))
                throw new Win32Exception();
            return unchecked((int)exitCode);
        }
        catch (Win32Exception error)
        {
            Console.Error.WriteLine("Codex Desktop CLI forwarding failed (Windows error {0}).", error.NativeErrorCode);
            return 70;
        }
        finally
        {
            if (child.Process != IntPtr.Zero && !resumed) TerminateProcess(child.Process, 70);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
            if (child.Process != IntPtr.Zero) CloseHandle(child.Process);
        }
    }

    private static int RunShared(Func<int> operation)
    {
        try { return operation(); }
        catch (Exception error)
        {
            // Provider errors may contain paths, protocol messages or authentication details.
            Console.Error.WriteLine("Codex Desktop Share connection failed ({0}).",
                error.GetBaseException().GetType().Name);
            return 70;
        }
    }
}
