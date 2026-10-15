// Dock app for QA Agent (run with: osascript -l JavaScript dock.js <url> <icon.icns> <node> <repo>)
// Starts the server (bin/qa-agent.js serve --open), shows the app icon in the Dock, and stops the server on Quit.
// The server also stops if this process disappears (serve --parent).
ObjC.import('Cocoa');

var qaKeep = {}; // keep references alive for the run loop

function run(argv) {
  var url = argv[0] || 'http://localhost:4747';
  var iconPath = argv[1];
  var node = argv[2];
  var repo = argv[3];

  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyRegular);
  var img = $.NSImage.alloc.initWithContentsOfFile(iconPath);
  if (!img.isNil()) app.applicationIconImage = img;

  function openBrowser() { $.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString(url)); }

  ObjC.registerSubclass({
    name: 'QADelegate',
    methods: {
      'openApp:': { types: ['void', ['id']], implementation: function () { openBrowser(); } },
      'applicationDockMenu:': { types: ['id', ['id']], implementation: function () { return qaKeep.dockMenu; } },
      'applicationShouldHandleReopen:hasVisibleWindows:': { types: ['bool', ['id', 'bool']], implementation: function () { openBrowser(); return true; } },
      'applicationWillTerminate:': {
        types: ['void', ['id']],
        implementation: function () {
          // Stop whatever server is on the port (also one that was already running), then the helper process.
          var stop = $.NSTask.alloc.init;
          stop.launchPath = node;
          stop.arguments = $([repo + '/bin/qa-agent.js', 'stop']);
          stop.launch;
          stop.waitUntilExit;
          if (qaKeep.task && qaKeep.task.isRunning) { qaKeep.task.terminate(); qaKeep.task.waitUntilExit(); }
        },
      },
    },
  });
  var delegate = $.QADelegate.alloc.init;
  qaKeep.delegate = delegate;
  app.delegate = delegate;

  function item(title, action, key, target) {
    var mi = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(title, action, key || '');
    if (target) mi.target = target;
    return mi;
  }

  // Main menu (needed for Cmd-Q)
  var mainMenu = $.NSMenu.alloc.init;
  var appItem = $.NSMenuItem.alloc.init;
  mainMenu.addItem(appItem);
  var appMenu = $.NSMenu.alloc.initWithTitle('QA Agent');
  appMenu.addItem(item('Open QA Agent in Browser', 'openApp:', 'o', delegate));
  appMenu.addItem($.NSMenuItem.separatorItem);
  appMenu.addItem(item('Quit QA Agent (stops server)', 'terminate:', 'q'));
  appItem.submenu = appMenu;
  app.mainMenu = mainMenu;

  // Dock right-click menu (macOS adds its own Quit item below these)
  var dockMenu = $.NSMenu.alloc.init;
  dockMenu.addItem(item('Open QA Agent in Browser', 'openApp:', '', delegate));
  qaKeep.dockMenu = dockMenu;

  // Server: if one is already running, `serve` adopts it; Quit stops it either way
  var task = $.NSTask.alloc.init;
  task.launchPath = node;
  // --parent: if this app dies (Force Quit, crash), the helper stops the server by itself
  task.arguments = $([repo + '/bin/qa-agent.js', 'serve', '--open', '--parent', String($.NSProcessInfo.processInfo.processIdentifier)]);
  task.currentDirectoryPath = repo;
  task.launch;
  qaKeep.task = task;

  app.run;
}
