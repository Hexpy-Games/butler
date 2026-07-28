using System;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

internal static class ButlerProcessHost
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint INFINITE = 0xFFFFFFFF;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const uint WAIT_FAILED = 0xFFFFFFFF;
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;
    private const int MAX_CANCELLATION_FRAME_CHARS = 8192;
    private const int LOGON32_LOGON_NETWORK = 3;
    private const int LOGON32_PROVIDER_DEFAULT = 0;

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        internal int nLength;
        internal IntPtr lpSecurityDescriptor;
        internal int bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        internal int cb;
        internal string lpReserved;
        internal string lpDesktop;
        internal string lpTitle;
        internal uint dwX;
        internal uint dwY;
        internal uint dwXSize;
        internal uint dwYSize;
        internal uint dwXCountChars;
        internal uint dwYCountChars;
        internal uint dwFillAttribute;
        internal uint dwFlags;
        internal short wShowWindow;
        internal short cbReserved2;
        internal IntPtr lpReserved2;
        internal IntPtr hStdInput;
        internal IntPtr hStdOutput;
        internal IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        internal IntPtr hProcess;
        internal IntPtr hThread;
        internal uint dwProcessId;
        internal uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        internal long PerProcessUserTimeLimit;
        internal long PerJobUserTimeLimit;
        internal uint LimitFlags;
        internal UIntPtr MinimumWorkingSetSize;
        internal UIntPtr MaximumWorkingSetSize;
        internal uint ActiveProcessLimit;
        internal UIntPtr Affinity;
        internal uint PriorityClass;
        internal uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        internal ulong ReadOperationCount;
        internal ulong WriteOperationCount;
        internal ulong OtherOperationCount;
        internal ulong ReadTransferCount;
        internal ulong WriteTransferCount;
        internal ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        internal JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        internal IO_COUNTERS IoInfo;
        internal UIntPtr ProcessMemoryLimit;
        internal UIntPtr JobMemoryLimit;
        internal UIntPtr PeakProcessMemoryUsed;
        internal UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(
        IntPtr jobAttributes,
        string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForMultipleObjects(
        uint count,
        IntPtr[] handles,
        bool waitAll,
        uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(
        uint desiredAccess,
        bool inheritHandle,
        uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool LogonUser(
        string username,
        string domain,
        string password,
        int logonType,
        int logonProvider,
        out IntPtr token);

    private static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--probe")
        {
            Console.Out.Write("butler-process-host-v1");
            return 0;
        }
        if (args.Length == 2 && args[0] == "--cancellation-pipe")
        {
            return RunCancellationPipe(args[1]);
        }
        if (args.Length == 2 && args[0] == "--pipe-client-probe")
        {
            return ProbeCancellationPipe(args[1]);
        }
        if (args.Length == 4 && args[0] == "--pipe-user-probe")
        {
            return ProbeCancellationPipeAsUser(args[1], args[2], args[3]);
        }
        int ownerPid = 0;
        string[] commandArgs = args;
        if (args.Length >= 3 && args[0] == "--owner-pid")
        {
            if (!Int32.TryParse(args[1], out ownerPid) || ownerPid <= 0)
            {
                Console.Error.Write("butler_process_host_error:invalid_owner_pid");
                return 125;
            }
            commandArgs = new string[args.Length - 2];
            Array.Copy(args, 2, commandArgs, 0, commandArgs.Length);
        }
        if (commandArgs.Length == 0)
        {
            Console.Error.Write("butler_process_host_error:missing_command");
            return 125;
        }

        IntPtr job = IntPtr.Zero;
        IntPtr process = IntPtr.Zero;
        IntPtr thread = IntPtr.Zero;
        IntPtr owner = IntPtr.Zero;
        try
        {
            if (ownerPid > 0)
            {
                owner = OpenProcess(SYNCHRONIZE, false, unchecked((uint)ownerPid));
                ThrowIfInvalid(owner, "open_owner");
            }
            job = CreateJobObject(IntPtr.Zero, null);
            ThrowIfInvalid(job, "create_job");
            ConfigureKillOnClose(job);

            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdInput = InheritableStandardHandle(STD_INPUT_HANDLE);
            startup.hStdOutput = InheritableStandardHandle(STD_OUTPUT_HANDLE);
            startup.hStdError = InheritableStandardHandle(STD_ERROR_HANDLE);

            PROCESS_INFORMATION child;
            StringBuilder commandLine = new StringBuilder(BuildCommandLine(commandArgs));
            if (!CreateProcess(
                commandArgs[0],
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CREATE_SUSPENDED | CREATE_NO_WINDOW,
                IntPtr.Zero,
                null,
                ref startup,
                out child))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "create_process");
            }
            process = child.hProcess;
            thread = child.hThread;

            if (!AssignProcessToJobObject(job, process))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "assign_job");
            }
            if (ResumeThread(thread) == 0xFFFFFFFF)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "resume_process");
            }
            if (owner != IntPtr.Zero)
            {
                uint waitResult = WaitForMultipleObjects(
                    2,
                    new IntPtr[] { process, owner },
                    false,
                    INFINITE);
                if (waitResult == WAIT_OBJECT_0 + 1)
                {
                    return 143;
                }
                if (waitResult == WAIT_FAILED || waitResult != WAIT_OBJECT_0)
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "wait_process_or_owner");
                }
            }
            else
            {
                WaitForSingleObject(process, INFINITE);
            }
            uint exitCode;
            if (!GetExitCodeProcess(process, out exitCode))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "read_exit_code");
            }
            return unchecked((int)exitCode);
        }
        catch (Exception error)
        {
            Win32Exception windowsError = error as Win32Exception;
            string code = windowsError == null
                ? error.GetType().Name
                : windowsError.NativeErrorCode.ToString();
            Console.Error.Write("butler_process_host_error:" + code);
            return 125;
        }
        finally
        {
            if (thread != IntPtr.Zero) CloseHandle(thread);
            if (process != IntPtr.Zero) CloseHandle(process);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (owner != IntPtr.Zero) CloseHandle(owner);
        }
    }

    private static int ProbeCancellationPipe(string pipeName)
    {
        try
        {
            using (NamedPipeClientStream pipe = new NamedPipeClientStream(
                ".",
                pipeName,
                PipeDirection.InOut))
            {
                pipe.Connect(750);
                return 10;
            }
        }
        catch (UnauthorizedAccessException)
        {
            return 20;
        }
        catch
        {
            return 21;
        }
    }

    private static int ProbeCancellationPipeAsUser(
        string pipeName,
        string username,
        string password)
    {
        IntPtr token = IntPtr.Zero;
        try
        {
            if (!LogonUser(
                username,
                ".",
                password,
                LOGON32_LOGON_NETWORK,
                LOGON32_PROVIDER_DEFAULT,
                out token))
            {
                return 22;
            }
            using (WindowsImpersonationContext context =
                WindowsIdentity.Impersonate(token))
            {
                return ProbeCancellationPipe(pipeName);
            }
        }
        finally
        {
            if (token != IntPtr.Zero) CloseHandle(token);
        }
    }

    private static int RunCancellationPipe(string pipeName)
    {
        if (String.IsNullOrWhiteSpace(pipeName) || pipeName.IndexOfAny(new char[] { '\\', '/' }) >= 0)
        {
            Console.Error.Write("butler_cancellation_pipe_error:invalid_name");
            return 125;
        }
        try
        {
            PipeSecurity security = CurrentUserPipeSecurity();
            bool announced = false;
            while (true)
            {
                using (NamedPipeServerStream pipe = new NamedPipeServerStream(
                    pipeName,
                    PipeDirection.InOut,
                    32,
                    PipeTransmissionMode.Byte,
                    PipeOptions.None,
                    4096,
                    4096,
                    security))
                {
                    if (!announced)
                    {
                        Console.Out.WriteLine("butler-cancellation-pipe-v1");
                        Console.Out.Flush();
                        announced = true;
                    }
                    pipe.WaitForConnection();
                    string request = ReadBoundedLine(pipe);
                    if (request == null) continue;
                    string requestBridge = Convert.ToBase64String(
                        Encoding.UTF8.GetBytes(request));
                    Console.Out.WriteLine(requestBridge);
                    Console.Out.Flush();
                    string responseBridge = Console.In.ReadLine();
                    if (responseBridge == null) return 0;
                    byte[] responseBytes = Convert.FromBase64String(responseBridge);
                    if (responseBytes.Length > 4096)
                    {
                        throw new InvalidDataException("response_too_large");
                    }
                    pipe.Write(responseBytes, 0, responseBytes.Length);
                    pipe.WriteByte((byte)'\n');
                    pipe.Flush();
                }
            }
        }
        catch (Exception error)
        {
            Win32Exception windowsError = error as Win32Exception;
            string code = windowsError == null
                ? error.GetType().Name
                : windowsError.NativeErrorCode.ToString();
            Console.Error.Write("butler_cancellation_pipe_error:" + code);
            return 125;
        }
    }

    private static PipeSecurity CurrentUserPipeSecurity()
    {
        WindowsIdentity identity = WindowsIdentity.GetCurrent();
        SecurityIdentifier user = identity.User;
        if (user == null) throw new InvalidOperationException("missing_user_sid");
        PipeSecurity security = new PipeSecurity();
        security.SetAccessRuleProtection(true, false);
        security.SetOwner(user);
        security.AddAccessRule(new PipeAccessRule(
            user,
            PipeAccessRights.ReadWrite | PipeAccessRights.CreateNewInstance,
            AccessControlType.Allow));
        return security;
    }

    private static string ReadBoundedLine(Stream stream)
    {
        MemoryStream bytes = new MemoryStream();
        while (bytes.Length <= MAX_CANCELLATION_FRAME_CHARS)
        {
            int value = stream.ReadByte();
            if (value < 0) return bytes.Length == 0 ? null : Encoding.UTF8.GetString(bytes.ToArray());
            if (value == '\n') return Encoding.UTF8.GetString(bytes.ToArray());
            bytes.WriteByte((byte)value);
        }
        throw new InvalidDataException("request_too_large");
    }

    private static void ConfigureKillOnClose(IntPtr job)
    {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits =
            new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, buffer, false);
            if (!SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                buffer,
                (uint)size))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "configure_job");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static IntPtr InheritableStandardHandle(int standardHandle)
    {
        IntPtr handle = GetStdHandle(standardHandle);
        if (handle != IntPtr.Zero && handle.ToInt64() != -1)
        {
            SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        }
        return handle;
    }

    private static string BuildCommandLine(string[] args)
    {
        StringBuilder value = new StringBuilder();
        for (int index = 0; index < args.Length; index++)
        {
            if (index > 0) value.Append(' ');
            value.Append(QuoteWindowsArgument(args[index]));
        }
        return value.ToString();
    }

    private static string QuoteWindowsArgument(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0)
        {
            return value;
        }
        StringBuilder quoted = new StringBuilder();
        quoted.Append('"');
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"')
            {
                quoted.Append('\\', backslashes * 2 + 1);
                quoted.Append('"');
                backslashes = 0;
                continue;
            }
            quoted.Append('\\', backslashes);
            backslashes = 0;
            quoted.Append(character);
        }
        quoted.Append('\\', backslashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }

    private static void ThrowIfInvalid(IntPtr handle, string operation)
    {
        if (handle == IntPtr.Zero || handle.ToInt64() == -1)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
        }
    }
}
