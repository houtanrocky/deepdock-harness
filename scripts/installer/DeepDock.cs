using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("DeepDock Harness Bridge")]
[assembly: System.Reflection.AssemblyVersion("0.2.1.0")]
[assembly: System.Reflection.AssemblyFileVersion("0.2.1.0")]

internal static class Program {
  internal static readonly string AppDir = AppDomain.CurrentDomain.BaseDirectory;
  internal static readonly string ConfigDir = Path.Combine(Environment.GetEnvironmentVariable("APPDATA") ?? Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "DeepDock");
  internal static readonly string UserKey = System.Security.Principal.WindowsIdentity.GetCurrent().User.Value;
  internal static readonly string EventPrefix = @"Local\DeepDock-" + UserKey + "-" + InstallKey();

  private static string InstallKey() {
    using (var hash = System.Security.Cryptography.SHA256.Create())
      return BitConverter.ToString(hash.ComputeHash(System.Text.Encoding.UTF8.GetBytes(AppDir.ToUpperInvariant()))).Replace("-", "").Substring(0, 16);
  }

  [STAThread]
  private static int Main(string[] args) {
    Application.EnableVisualStyles();
    Application.SetCompatibleTextRenderingDefault(false);
    bool created;
    using (var mutex = new Mutex(true, EventPrefix + "-app", out created)) {
      if (args.Length > 0 && args[0] == "--shutdown") {
        // Installer/uninstaller: ask the existing app to close and wait for it.
        if (!created) {
          try { using (var signal = EventWaitHandle.OpenExisting(EventPrefix + "-exit")) signal.Set(); }
          catch (WaitHandleCannotBeOpenedException) { return 1; }
          if (!mutex.WaitOne(30000)) return 1;
          return 0;
        }
        try { Controller.Run("stop").GetAwaiter().GetResult(); return 0; }
        catch {
          try { return Controller.HasBridgeProcess() ? 1 : 0; }
          catch { return 1; }
        }
      }
      if (!created) {
        try { using (var signal = EventWaitHandle.OpenExisting(EventPrefix + "-show")) signal.Set(); }
        catch (WaitHandleCannotBeOpenedException) { return 1; }
        return 0;
      }
      try { Application.Run(new BridgeWindow()); }
      finally { mutex.ReleaseMutex(); }
    }
    return 0;
  }
}

internal static class Controller {
  internal static bool HasBridgeProcess() {
    return BridgeRecovery.FindTargets(false).Count > 0;
  }
  internal static async Task<Dictionary<string, object>> Run(string action) {
    var info = new ProcessStartInfo(Path.Combine(Program.AppDir, "node.exe"), "\"" + Path.Combine(Program.AppDir, "bridge-host.cjs") + "\" " + action) {
      UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true,
      RedirectStandardError = true, WorkingDirectory = Program.AppDir
    };
    using (var process = Process.Start(info)) {
      var output = process.StandardOutput.ReadToEndAsync();
      var errors = process.StandardError.ReadToEndAsync();
      var exit = Task.Run(() => process.WaitForExit());
      if (await Task.WhenAny(exit, Task.Delay(25000)) != exit) {
        try { process.Kill(); } catch (InvalidOperationException) { }
        throw new Exception("The bridge did not respond. Check Help or use Force stop bridge to recover.");
      }
      await exit;
      var text = await output;
      await errors;
      Dictionary<string, object> result;
      try { result = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(text); }
      catch { throw new Exception("Could not read bridge status. Open the logs from Help for details."); }
      if (result == null || !result.ContainsKey("ok") || !(bool)result["ok"])
        throw new Exception(result != null && result.ContainsKey("error") ? Convert.ToString(result["error"]) : "Bridge operation failed.");
      return result;
    }
  }

}

internal sealed class BridgeWindow : Form {
  private readonly NotifyIcon tray = new NotifyIcon();
  private readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
  private readonly EventWaitHandle showSignal = new EventWaitHandle(false, EventResetMode.AutoReset, Program.EventPrefix + "-show");
  private readonly EventWaitHandle exitSignal = new EventWaitHandle(false, EventResetMode.AutoReset, Program.EventPrefix + "-exit");
  private readonly Label status = new Label();
  private readonly Label address = new Label();
  private readonly Label workspace = new Label();
  private readonly Label feedback = new Label();
  private readonly Button start = new Button();
  private readonly Button stop = new Button();
  private readonly Button forceStop = new Button();
  private readonly TabControl tabs = new TabControl();
  private ToolStripMenuItem trayStart, trayStop, trayForce, trayExit;
  private bool busy, exiting;
  private bool? bridgeRunning;
  private int ticks;

  internal BridgeWindow() {
    Text = "DeepDock Harness Bridge";
    Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application;
    Font = new Font("Segoe UI", 10F);
    ClientSize = new Size(620, 730);
    MinimumSize = new Size(620, 650);
    AutoScaleMode = AutoScaleMode.Dpi;
    StartPosition = FormStartPosition.CenterScreen;
    tabs.Dock = DockStyle.Fill;
    Controls.Add(tabs);
    var bridge = new TabPage("Bridge");
    var help = new TabPage("Help & setup");
    tabs.TabPages.Add(bridge); tabs.TabPages.Add(help);
    var layout = PageLayout(bridge);
    AddLabel(layout, "Your local workspace, on your terms", 19, FontStyle.Bold);
    AddLabel(layout, "Start the bridge when you need local tools in DeepSeek. Opening this app does not start the bridge.", 10, FontStyle.Regular);
    SetupLabel(status, layout, "Checking bridge status...", 16, FontStyle.Bold);
    SetupLabel(address, layout, "", 10, FontStyle.Regular);
    SetupLabel(workspace, layout, "", 10, FontStyle.Regular);
    var buttons = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Top, WrapContents = true };
    layout.Controls.Add(buttons);
    SetupButton(start, buttons, "Start bridge", async () => await Operate("start"));
    SetupButton(stop, buttons, "Stop bridge", async () => await Operate("stop"));
    SetupButton(new Button(), buttons, "Copy token", CopyToken);
    start.Enabled = stop.Enabled = false;
    AddLabel(layout, "Connect the extension", 13, FontStyle.Bold);
    AddLabel(layout, "1. Click Start bridge, then Copy token here.\r\n2. Open DeepSeek and find the DeepDock Harness panel.\r\n3. Open Settings > Bridge token. Paste and Save settings.\r\n4. Click Test connection, then Enable agent.", 10, FontStyle.Regular);
    var links = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Top };
    layout.Controls.Add(links);
    SetupButton(new Button(), links, "Open DeepSeek", () => Open("https://chat.deepseek.com"));
    SetupButton(new Button(), links, "Help & setup", () => tabs.SelectedTab = help);
    SetupLabel(feedback, layout, "Closing this window keeps the app in the system tray. Use Exit to stop the bridge and close the app.", 10, FontStyle.Regular);
    var recovery = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Top };
    layout.Controls.Add(recovery);
    SetupButton(forceStop, recovery, "Force stop bridge...", async () => await ForceStop());
    SetupButton(new Button(), recovery, "Exit", async () => await ExitApp());

    var helpLayout = PageLayout(help);
    AddLabel(helpLayout, "Get connected", 19, FontStyle.Bold);
    AddLabel(helpLayout, "The desktop app manages your bridge. The browser extension adds local tools to DeepSeek. You need both.", 10, FontStyle.Regular);
    AddLabel(helpLayout, "Pair once", 13, FontStyle.Bold);
    AddLabel(helpLayout, "In the Bridge tab, click Copy token. In the DeepDock Harness panel on DeepSeek, open Settings > Bridge token, paste it, and click Save settings. Then Test connection and Enable agent. Keep your token private; never paste it into a chat message.", 10, FontStyle.Regular);
    AddLabel(helpLayout, "Start and stop", 13, FontStyle.Bold);
    AddLabel(helpLayout, "Click Start bridge when you want to work. Stop bridge shuts it down. If a coding task is active, stop or finish it in the extension first. Force stop bridge also detects older DeepDock bridges using the configured port, even from another install folder or Node runtime. Review the process paths before confirming.", 10, FontStyle.Regular);
    AddLabel(helpLayout, "Tray and startup", 13, FontStyle.Bold);
    AddLabel(helpLayout, "Closing the window hides it in the tray near the Windows clock. Double-click the tray icon to reopen it, or right-click for controls. Exit stops the bridge and closes the app. DeepDock is not added to Windows startup. Upgrade removes the old startup shortcut.", 10, FontStyle.Regular);
    AddLabel(helpLayout, "Connection trouble?", 13, FontStyle.Bold);
    AddLabel(helpLayout, "Check that the bridge is running, copy the token again, and match the bridge address shown in the Bridge tab with Settings > Bridge address. After an extension update, refresh your DeepSeek tabs. If Stop fails, use Force stop bridge, then Start bridge.", 10, FontStyle.Regular);
    var helpButtons = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Top };
    helpLayout.Controls.Add(helpButtons);
    SetupButton(new Button(), helpButtons, "Open logs", OpenLogs);
    SetupButton(new Button(), helpButtons, "Project guide", () => Open("https://houtanrocky.github.io/deepdock-harness/"));

    var menu = new ContextMenuStrip();
    menu.Items.Add("Open DeepDock", null, (s, e) => ShowWindow());
    trayStart = new ToolStripMenuItem("Start bridge", null, async (s, e) => await Operate("start")); menu.Items.Add(trayStart);
    trayStop = new ToolStripMenuItem("Stop bridge", null, async (s, e) => await Operate("stop")); menu.Items.Add(trayStop);
    menu.Items.Add("Copy token", null, (s, e) => CopyToken());
    menu.Items.Add("Help & setup", null, (s, e) => { ShowWindow(); tabs.SelectedTab = help; });
    trayForce = new ToolStripMenuItem("Force stop bridge...", null, async (s, e) => await ForceStop()); menu.Items.Add(trayForce);
    menu.Items.Add(new ToolStripSeparator());
    trayExit = new ToolStripMenuItem("Exit", null, async (s, e) => await ExitApp()); menu.Items.Add(trayExit);
    tray.Icon = Icon; tray.Text = "DeepDock - checking bridge"; tray.ContextMenuStrip = menu; tray.Visible = true;
    tray.DoubleClick += (s, e) => ShowWindow();
    Shown += async (s, e) => await Operate("status");
    FormClosing += (s, e) => {
      if (exiting || e.CloseReason == CloseReason.WindowsShutDown) return;
      e.Cancel = true; Hide();
      tray.ShowBalloonTip(3000, "DeepDock is in the tray", "Right-click the DeepDock tray icon to stop the bridge or exit.", ToolTipIcon.Info);
    };
    timer.Interval = 500;
    timer.Tick += async (s, e) => {
      if (showSignal.WaitOne(0)) ShowWindow();
      if (exitSignal.WaitOne(0)) await ExitApp(false);
      if (++ticks >= 20) { ticks = 0; if (!busy) await Operate("status"); }
    };
    timer.Start();
  }

  private static FlowLayoutPanel PageLayout(Control parent) {
    var panel = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true, Padding = new Padding(22) };
    parent.Controls.Add(panel); return panel;
  }
  private static void SetupLabel(Label label, Control parent, string text, float size, FontStyle style) {
    label.Text = text; label.AutoSize = true; label.MaximumSize = new Size(540, 0);
    label.Font = new Font("Segoe UI", size, style); label.Margin = new Padding(0, 0, 0, 16); parent.Controls.Add(label);
  }
  private static void AddLabel(Control parent, string text, float size, FontStyle style) { SetupLabel(new Label(), parent, text, size, style); }
  private static void SetupButton(Button button, Control parent, string text, Action action) {
    button.UseMnemonic = false;
    button.Text = text; button.AutoSize = true; button.Padding = new Padding(8, 4, 8, 4); button.Margin = new Padding(0, 0, 8, 12);
    button.Click += (s, e) => action(); parent.Controls.Add(button);
  }
  private void ShowWindow() { Show(); WindowState = FormWindowState.Normal; Activate(); }
  private void Open(string target) {
    try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); }
    catch (Exception error) { ShowError(error.Message); }
  }
  private void OpenLogs() {
    try {
      string logs = Path.Combine(Program.ConfigDir, "logs");
      Directory.CreateDirectory(logs); Open(logs);
    } catch (Exception error) { ShowError(error.Message); }
  }
  private void ShowError(string message) {
    feedback.Text = message; ShowWindow();
    MessageBox.Show(this, message, "DeepDock Harness Bridge", MessageBoxButtons.OK, MessageBoxIcon.Warning);
  }
  private void CopyToken() {
    try {
      var config = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(Program.ConfigDir, "config.json")));
      string token = Convert.ToString(config["token"]);
      if (token.Length < 32) throw new Exception("Pairing is incomplete. Run the installer again.");
      Clipboard.SetText(token);
      feedback.Text = "Token copied. In DeepSeek: DeepDock Harness > Settings > Bridge token > paste > Save settings.";
      tray.ShowBalloonTip(3000, "Token copied", "Paste in DeepDock Harness > Settings > Bridge token, then Save settings.", ToolTipIcon.Info);
    } catch (Exception error) { ShowError(error.Message); }
  }
  private void SetBusy(bool value) {
    busy = value;
    start.Enabled = trayStart.Enabled = !value && bridgeRunning != true;
    stop.Enabled = trayStop.Enabled = !value && bridgeRunning != false;
    forceStop.Enabled = trayForce.Enabled = !value && bridgeRunning != false;
    trayExit.Enabled = !value;
  }
  private async Task<bool> Operate(string action, bool showErrors = true) {
    if (busy) return false;
    SetBusy(true);
    try {
      if (action != "status") feedback.Text = action == "start" ? "Starting bridge..." : "Stopping bridge...";
      var result = await Controller.Run(action);
      bool running = (bool)result["running"];
      bridgeRunning = running;
      status.Text = running ? "Bridge running" : "Bridge stopped";
      status.ForeColor = running ? Color.SeaGreen : Color.DimGray;
      address.Text = "Bridge address: " + result["address"];
      workspace.Text = "Project folder: " + result["workspace"];
      tray.Text = running ? "DeepDock - bridge running" : "DeepDock - bridge stopped";
      if (action != "status") feedback.Text = running ? "Bridge ready. Copy token, then open Settings > Bridge token in the extension." : "Bridge stopped. Click Start bridge when you need it again.";
      return true;
    } catch (Exception error) {
      bridgeRunning = null;
      status.Text = "Bridge needs attention"; status.ForeColor = Color.Firebrick;
      tray.Text = "DeepDock - bridge needs attention"; feedback.Text = error.Message;
      if (action != "status" && showErrors) ShowError(error.Message);
      return false;
    } finally { SetBusy(false); }
  }
  private Task ForceStop() { return ConfirmForceStop(); }
  private async Task<bool> ConfirmForceStop() {
    if (busy) return false;
    ShowWindow();
    SetBusy(true);
    bool stopped = false;
    try {
      var targets = await Task.Run(() => BridgeRecovery.FindTargets(true));
      if (targets.Count > 0) {
        string details = String.Join("\r\n\r\n", targets.ConvertAll(target => "PID " + target.Pid + (target.Legacy ? " (older or source installation)" : "") + "\r\n" + target.Script + "\r\nRuntime: " + target.Executable));
        if (MessageBox.Show(this, "Force stop these DeepDock bridge processes and their child commands?\r\n\r\n" + details + "\r\n\r\nAny running coding task will be interrupted. Unsaved command output may be lost.", "Force stop bridge", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return false;
        await Task.Run(() => BridgeRecovery.Stop(targets));
      }
      stopped = true;
    }
    catch (Exception error) { ShowError(error.Message); }
    finally { SetBusy(false); }
    await Operate("status");
    return stopped;
  }
  private async Task ExitApp(bool allowForce = true) {
    if (busy || exiting) return;
    if (!await Operate("stop", false)) {
      bool hasBridge;
      try { hasBridge = await Task.Run(() => Controller.HasBridgeProcess()); }
      catch (Exception error) { ShowError(error.Message); return; }
      if (hasBridge) {
        ShowWindow();
        if (!allowForce || !await ConfirmForceStop()) return;
      }
    }
    exiting = true; Close();
  }
  protected override void Dispose(bool disposing) {
    if (disposing) { timer.Dispose(); tray.Visible = false; tray.Dispose(); showSignal.Dispose(); exitSignal.Dispose(); }
    base.Dispose(disposing);
  }
}
