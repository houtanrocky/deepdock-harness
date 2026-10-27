using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

internal sealed class RecoveryTarget {
  internal uint Pid;
  internal string Created, CommandLine, Executable, Script;
  internal bool Legacy;
}

internal static class BridgeRecovery {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
  [DllImport("kernel32.dll")]
  private static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("iphlpapi.dll")]
  private static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool sorted, int family, int tableClass, uint reserved);
  [StructLayout(LayoutKind.Sequential)]
  private struct TcpRow { internal uint State, Address, Port, RemoteAddress, RemotePort, Pid; }

  private static int? ConfiguredPort() {
    try {
      var config = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(Program.ConfigDir, "config.json")));
      if (config == null) return null;
      int port = config.ContainsKey("port") ? Convert.ToInt32(config["port"]) : 8765;
      return port > 0 && port <= 65535 ? (int?)port : null;
    } catch (IOException) { return null; }
    catch (UnauthorizedAccessException) { return null; }
    catch (ArgumentException) { return null; }
    catch (InvalidOperationException) { return null; }
    catch (FormatException) { return null; }
    catch (OverflowException) { return null; }
  }

  private static HashSet<uint> ListenerPids(int? port) {
    var result = new HashSet<uint>();
    if (!port.HasValue) return result;
    int size = 0;
    // AF_INET, TCP_TABLE_OWNER_PID_LISTENER. Each row carries its owning PID.
    uint error = GetExtendedTcpTable(IntPtr.Zero, ref size, false, 2, 3, 0);
    for (int attempt = 0; attempt < 3; attempt++) {
      if (error != 122 && error != 0) throw new Exception("Windows could not identify the process using the bridge port (" + error + ").");
      IntPtr table = Marshal.AllocHGlobal(size);
      try {
        error = GetExtendedTcpTable(table, ref size, false, 2, 3, 0);
        if (error == 122) continue;
        if (error != 0) throw new Exception("Windows could not inspect the bridge port (" + error + ").");
        int count = Marshal.ReadInt32(table);
        int rowSize = Marshal.SizeOf(typeof(TcpRow));
        for (int index = 0; index < count; index++) {
          var row = (TcpRow)Marshal.PtrToStructure(IntPtr.Add(table, 4 + index * rowSize), typeof(TcpRow));
          uint localPort = ((row.Port & 255) << 8) | ((row.Port >> 8) & 255);
          if (row.Address == 0x0100007f && localPort == port.Value) result.Add(row.Pid);
        }
        return result;
      } finally { Marshal.FreeHGlobal(table); }
    }
    throw new Exception("The bridge port changed while Windows was inspecting it. Try again.");
  }

  private static string ScriptPath(string commandLine) {
    if (String.IsNullOrEmpty(commandLine)) return null;
    int count;
    IntPtr argv = CommandLineToArgvW(commandLine, out count);
    if (argv == IntPtr.Zero) return null;
    try {
      if (count < 2) return null;
      string script = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, IntPtr.Size));
      // Only the actual Node entrypoint counts; a server path in -e or later
      // arguments must never identify an unrelated command as the bridge.
      if (!Path.IsPathRooted(script)) return null;
      return Path.GetFullPath(script);
    } catch (ArgumentException) { return null; }
    finally { LocalFree(argv); }
  }

  private static bool HasBridgeSource(string script) {
    try {
      if (!String.Equals(Path.GetFileName(script), "server.js", StringComparison.OrdinalIgnoreCase) ||
          !String.Equals(Path.GetFileName(Path.GetDirectoryName(script)), "bridge", StringComparison.OrdinalIgnoreCase)) return false;
      var file = new FileInfo(script);
      if (!file.Exists || file.Length > 1024 * 1024) return false;
      string source = File.ReadAllText(script);
      return Regex.IsMatch(source, "['\"](?:dsh-pro|deepdock)['\"]") &&
        Regex.IsMatch(source, "['\"]/health['\"]") && Regex.IsMatch(source, "['\"]/tools['\"]") &&
        source.Contains("Bearer") && source.Contains("127.0.0.1");
    } catch (IOException) { return false; }
    catch (UnauthorizedAccessException) { return false; }
  }

  private static RecoveryTarget Identify(ManagementObject process, HashSet<uint> listeners) {
    string executable = Convert.ToString(process["ExecutablePath"]);
    if (!String.Equals(Path.GetFileName(executable), "node.exe", StringComparison.OrdinalIgnoreCase)) return null;
    string commandLine = Convert.ToString(process["CommandLine"]);
    string script = ScriptPath(commandLine);
    if (script == null) return null;
    uint pid = Convert.ToUInt32(process["ProcessId"]);
    bool own = String.Equals(executable, Path.Combine(Program.AppDir, "node.exe"), StringComparison.OrdinalIgnoreCase) &&
      String.Equals(script, Path.Combine(Program.AppDir, "bridge", "server.js"), StringComparison.OrdinalIgnoreCase);
    if (!own && (!listeners.Contains(pid) || !HasBridgeSource(script))) return null;
    using (var ownerProcess = new ManagementObject("Win32_Process.Handle='" + pid + "'")) {
      using (var owner = ownerProcess.InvokeMethod("GetOwnerSid", null, null)) {
        if (owner == null || Convert.ToUInt32(owner["ReturnValue"]) != 0 || Convert.ToString(owner["Sid"]) != Program.UserKey) return null;
      }
    }
    return new RecoveryTarget { Pid = pid, Created = Convert.ToString(process["CreationDate"]),
      CommandLine = commandLine, Executable = executable, Script = script, Legacy = !own };
  }

  internal static List<RecoveryTarget> FindTargets(bool rejectUnknownListener) {
    int? port = ConfiguredPort();
    var listeners = ListenerPids(port);
    var unknown = new HashSet<uint>(listeners);
    var targets = new List<RecoveryTarget>();
    using (var search = new ManagementObjectSearcher("SELECT ProcessId, CreationDate, ExecutablePath, CommandLine FROM Win32_Process WHERE Name = 'node.exe'")) {
      foreach (ManagementObject process in search.Get()) {
        using (process) {
          var target = Identify(process, listeners);
          if (target == null) continue;
          targets.Add(target); unknown.Remove(target.Pid);
        }
      }
    }
    if (rejectUnknownListener && unknown.Count > 0)
      throw new Exception("Port " + port + " is used by process " + String.Join(", ", unknown) + ", which could not be verified as a DeepDock bridge owned by your Windows account. No process was stopped.");
    return targets;
  }

  internal static void Stop(List<RecoveryTarget> targets) {
    foreach (var target in targets) {
      using (var current = new ManagementObject("Win32_Process.Handle='" + target.Pid + "'")) {
        try { current.Get(); } catch (ManagementException error) {
          if (error.ErrorCode == ManagementStatus.NotFound) continue;
          throw;
        }
        var verified = Identify(current, ListenerPids(ConfiguredPort()));
        if (verified == null || verified.Created != target.Created || verified.CommandLine != target.CommandLine || verified.Executable != target.Executable)
          throw new Exception("The bridge process changed after confirmation. Inspect its status and try again.");
      }
      using (var killer = Process.Start(new ProcessStartInfo("taskkill.exe", "/PID " + target.Pid + " /T /F") {
        UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true
      })) {
        var output = killer.StandardOutput.ReadToEndAsync();
        var errors = killer.StandardError.ReadToEndAsync();
        if (!killer.WaitForExit(10000)) { killer.Kill(); throw new Exception("Windows could not stop the bridge. Try again."); }
        Task.WaitAll(output, errors);
        if (killer.ExitCode != 0) throw new Exception("Windows could not stop bridge process " + target.Pid + ". Check that this app is running under the same Windows account as the bridge.");
      }
    }
    if (FindTargets(false).Count > 0) throw new Exception("A DeepDock bridge is still running. Refresh its status and try again.");
  }
}
