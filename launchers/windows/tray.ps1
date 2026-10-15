# QA Agent tray launcher for Windows. Starts the server, opens the browser, shows a notification-area icon.
# "Quit" in the tray menu stops the server (and so does the tray process disappearing).
param(
  [Parameter(Mandatory)] [string]$Repo,
  [Parameter(Mandatory)] [string]$Node,
  [Parameter(Mandatory)] [string]$Icon,
  [int]$Port = 4747
)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:url = "http://localhost:$Port"
$env:PORT = "$Port"
# --parent: if this tray process dies, the helper stops the server by itself
$script:srv = Start-Process -FilePath $Node -ArgumentList "`"$Repo\bin\qa-agent.js`"", 'serve', '--open', '--parent', "$PID" -WindowStyle Hidden -PassThru

$script:ni = New-Object System.Windows.Forms.NotifyIcon
$script:ni.Icon = New-Object System.Drawing.Icon($Icon)
$script:ni.Text = 'QA Agent'
$script:ni.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add('Open QA Agent')
$open.add_Click({ Start-Process $script:url })
$quit = $menu.Items.Add('Quit (stops server)')
$quit.add_Click({
  $script:ni.Visible = $false
  # stop whatever server is on the port (also one that was already running), then the helper
  & $Node "$Repo\bin\qa-agent.js" stop | Out-Null
  if ($script:srv -and -not $script:srv.HasExited) { & taskkill.exe /PID $script:srv.Id /T /F | Out-Null }
  [System.Windows.Forms.Application]::Exit()
})
$script:ni.ContextMenuStrip = $menu
$script:ni.add_DoubleClick({ Start-Process $script:url })

[System.Windows.Forms.Application]::Run()
